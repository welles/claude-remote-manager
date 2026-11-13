import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  MAX_PREVIEW_NAME_LENGTH,
  MAX_PREVIEWS_PER_SESSION,
  type PreviewDto,
  type PreviewState,
  type PreviewStopper,
  type SessionEventInput,
} from '@claude-remote-manager/shared-types';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import {
  APP_CONFIG,
  type AppConfig,
  type PreviewConfig,
} from '../config/app-config';
import type { PreviewRow } from '../db/schema';
import { DevServers } from '../dev-servers/dev-servers';
import { SessionRepository } from '../sessions/session.repository';
import { PreviewRepository } from './preview.repository';
import {
  UpstreamAgent,
  type Closable,
  type PreviewUpstream,
} from './preview-proxy';
import { readSocketTables, type SocketTables } from './socket-table';
import {
  checkListener,
  portPolicy,
  upstreamConnector,
  type PortPolicy,
} from './upstream';

/** An event of a session's history (recorded by the sessions module). */
export interface PreviewEvent {
  sessionId: string;
  event: SessionEventInput;
}

/** What {@link PreviewsService.expose} did. */
export interface ExposeResult {
  preview: PreviewDto;
  /** `false` when the port was exposed by this session already. */
  created: boolean;
}

/** How often the states of active previews are checked. */
export const PREVIEW_STATE_INTERVAL_MS = 3000;
/** How long a dev server gets to end after SIGTERM when its session ends. */
export const STOP_GRACE_MS = 5000;

export const STOP_LISTENERS_SCRIPT = 'stop-listeners.cjs';

function stopListenersScript(): string {
  const candidates = [
    join(__dirname, 'assets', STOP_LISTENERS_SCRIPT),
    join(__dirname, '..', '..', 'assets', STOP_LISTENERS_SCRIPT),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${STOP_LISTENERS_SCRIPT} not found`);
  }
  return found;
}

/** Longest DNS label. */
const MAX_LABEL_LENGTH = 63;

/**
 * First label of a preview's host name: `<session slug>-<port>`. Slugs are
 * unique, lower-case `[a-z0-9-]` and end with a random part, and the port
 * has no dash, so labels never collide between sessions. Sessions without
 * a slug (older ones) use their ID.
 */
export function previewLabel(
  session: { id: string; slug: string | null },
  port: number,
): string {
  const label = `${session.slug ?? `s${session.id.replace(/-/g, '')}`}-${port}`;
  return label.length <= MAX_LABEL_LENGTH
    ? label
    : `s${session.id.replace(/-/g, '').slice(0, 24)}-${port}`;
}

/** URL of a preview host: `<scheme>://<label>.<domain>[:port]`. */
export function previewUrl(config: PreviewConfig, label: string): string {
  return `${config.scheme}://${label}.${config.domain}${config.port ? `:${config.port}` : ''}`;
}

/**
 * Previews of dev servers (spec step 10). Claude exposes a port of its
 * session with the tool `expose_port`; from then on the host name
 * `<session slug>-<port>.<preview domain>` is forwarded to it (see
 * {@link PreviewGateway}), until the user or Claude stops it or the
 * session ends.
 *
 * Only ports a process of the session user listens on, on loopback, can be
 * forwarded, never the API's own (see {@link PortPolicy}); every
 * connection to the dev server is checked again when it is made.
 *
 * Stopping a preview ends the forwarding, not the dev server. When the
 * session ends, the processes listening on its exposed ports are stopped
 * too (SIGTERM, then SIGKILL), with separate users only: they are found
 * as the session user, among the session user's processes. In
 * `single-user` development the listener might be any program of the
 * developer's, so nothing is killed.
 */
@Injectable()
export class PreviewsService
  extends DevServers
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PreviewsService.name);
  private readonly policy: PortPolicy;
  private readonly upstreams = new Map<
    string,
    PreviewUpstream & { closables: Set<Closable> }
  >();
  private readonly states = new Map<
    string,
    { state: PreviewState; problem: string | null }
  >();
  private readonly eventSubject = new Subject<PreviewEvent>();
  private readonly changeSubject = new Subject<string>();
  private timer: NodeJS.Timeout | null = null;
  private server: Server | null = null;

  /** Events for the sessions' histories. */
  readonly events$ = this.eventSubject.asObservable();
  /** Sessions whose previews changed (state, added, stopped). */
  readonly changes$ = this.changeSubject.asObservable();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly previews: PreviewRepository,
    private readonly sessions: SessionRepository,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
    @Optional()
    @Inject('PREVIEW_SOCKET_TABLES')
    private readonly tables: SocketTables = readSocketTables,
  ) {
    super();
    this.policy = portPolicy(config.isolation, () => this.forbiddenPorts());
  }

  /** The preview configuration; `null` when previews are off. */
  get settings(): PreviewConfig | null {
    return this.config.previews;
  }

  get enabled(): boolean {
    return this.config.previews !== null;
  }

  onModuleInit(): void {
    // Sessions that ended while the server was down keep no previews.
    for (const row of this.previews.active()) {
      if (this.sessions.get(row.sessionId)?.status === 'finished') {
        this.previews.stop(row.id, 'session_end');
      }
    }
    this.refreshStates();
  }

  onModuleDestroy(): void {
    this.stopMonitor();
    for (const id of [...this.upstreams.keys()]) {
      this.closeUpstream(id);
    }
  }

  /** The HTTP server the API listens on: its port is never forwarded. */
  attachServer(server: Server): void {
    this.server = server;
  }

  private forbiddenPorts(): number[] {
    const ports: number[] = [];
    const address = this.server?.address();
    if (address && typeof address === 'object') {
      ports.push(address.port);
    }
    try {
      const url = new URL(this.config.internalApiUrl);
      ports.push(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
    } catch {
      // not a URL: nothing more to refuse
    }
    return ports;
  }

  // --- Claude's tools --------------------------------------------------------

  /**
   * Exposes a port of the session (tool `expose_port`). Re-exposing the
   * session's own port renames it. Refuses the API's port, ports of other
   * users and ports bound elsewhere than loopback; accepts a port nothing
   * listens on yet (the preview waits for it).
   */
  expose(
    sessionId: string,
    port: number,
    name: string,
    toolUseId: string | null,
  ): ExposeResult {
    const settings = this.requireEnabled();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException(
        'The port must be a number from 1 to 65535',
      );
    }
    const cleanName = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
    if (!cleanName || cleanName.length > MAX_PREVIEW_NAME_LENGTH) {
      throw new BadRequestException(
        `The name must have 1 to ${MAX_PREVIEW_NAME_LENGTH} characters`,
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const existing = this.previews.activeByPort(port);
    if (existing && existing.sessionId !== sessionId) {
      throw new ConflictException(
        `Port ${port} is exposed by another session already`,
      );
    }
    const check = checkListener(port, this.policy, this.tables);
    if (!check.ok && check.reason !== 'nothing') {
      throw new BadRequestException(check.message);
    }
    if (existing) {
      const row =
        existing.name === cleanName
          ? existing
          : this.previews.rename(existing.id, cleanName);
      this.changeSubject.next(sessionId);
      return { preview: this.toDto(row, settings), created: false };
    }
    if (
      this.previews.activeForSession(sessionId).length >=
      MAX_PREVIEWS_PER_SESSION
    ) {
      throw new BadRequestException(
        `A session can have at most ${MAX_PREVIEWS_PER_SESSION} previews; stop one first`,
      );
    }
    let row: PreviewRow;
    try {
      row = this.previews.add({
        sessionId,
        port,
        name: cleanName,
        label: previewLabel(session, port),
      });
    } catch {
      throw new ConflictException(`Port ${port} is exposed already`);
    }
    this.refreshStates();
    const preview = this.toDto(row, settings);
    this.eventSubject.next({
      sessionId,
      event: { type: 'preview.exposed', toolUseId, preview },
    });
    this.changeSubject.next(sessionId);
    return { preview, created: true };
  }

  /** Stops the session's preview of a port (tool `stop_preview`). */
  stopPort(
    sessionId: string,
    port: number,
    toolUseId: string | null,
  ): PreviewDto {
    const row = this.previews
      .activeForSession(sessionId)
      .find((candidate) => candidate.port === port);
    if (!row) {
      throw new NotFoundException(
        `This session has no preview of port ${port}`,
      );
    }
    return this.stopRow(row, 'claude', toolUseId);
  }

  /** Stops a preview of a session (the user's stop button). */
  stop(sessionId: string, previewId: string): PreviewDto {
    const row = this.previews.get(previewId);
    if (!row || row.sessionId !== sessionId) {
      throw new NotFoundException(`Preview ${previewId} not found`);
    }
    if (row.stoppedAt) {
      return this.toDto(row, this.requireEnabled());
    }
    return this.stopRow(row, 'user', null);
  }

  /**
   * Stops all previews of a session and, with separate users, the
   * processes listening on their ports (session ended, autoclose,
   * cleanup).
   */
  async stopSession(sessionId: string): Promise<void> {
    const rows = this.previews.activeForSession(sessionId);
    if (rows.length === 0) {
      return;
    }
    const ports = rows
      .filter((row) => checkListener(row.port, this.policy, this.tables).ok)
      .map((row) => row.port);
    for (const row of rows) {
      this.stopRow(row, 'session_end', null);
    }
    if (ports.length > 0 && this.launcher.separated) {
      await this.stopListeners(ports);
    }
  }

  /** Active previews of a session with their current state. */
  forSession(sessionId: string): PreviewDto[] {
    const settings = this.config.previews;
    if (!settings) {
      return [];
    }
    return this.previews
      .activeForSession(sessionId)
      .map((row) => this.toDto(row, settings));
  }

  // --- The gateway -------------------------------------------------------------

  /**
   * The active preview of a host label, with its upstream; or why there
   * is none (`stopped`: it existed, `unknown`: never).
   */
  resolve(
    label: string,
  ):
    | { found: true; row: PreviewRow; upstream: PreviewUpstream }
    | { found: false; reason: 'stopped' | 'unknown' } {
    const row = this.previews.activeByLabel(label);
    if (!row) {
      return {
        found: false,
        reason: this.previews.latestByLabel(label) ? 'stopped' : 'unknown',
      };
    }
    return { found: true, row, upstream: this.upstream(row) };
  }

  private upstream(row: PreviewRow): PreviewUpstream {
    let upstream = this.upstreams.get(row.id);
    if (!upstream) {
      const connect = upstreamConnector(row.port, this.policy, this.tables);
      const closables = new Set<Closable>();
      upstream = {
        port: row.port,
        connect,
        agent: new UpstreamAgent(connect),
        closables,
        track: (resource) => {
          closables.add(resource);
          return () => closables.delete(resource);
        },
      };
      this.upstreams.set(row.id, upstream);
    }
    return upstream;
  }

  private closeUpstream(id: string): void {
    const upstream = this.upstreams.get(id);
    if (!upstream) {
      return;
    }
    this.upstreams.delete(id);
    for (const resource of [...upstream.closables]) {
      resource.destroy();
    }
    upstream.agent.destroy();
  }

  // --- State -------------------------------------------------------------------

  private stopRow(
    row: PreviewRow,
    by: PreviewStopper,
    toolUseId: string | null,
  ): PreviewDto {
    const stopped = this.previews.stop(row.id, by) ?? row;
    this.closeUpstream(row.id);
    this.states.delete(row.id);
    if (stopped.stoppedAt && !row.stoppedAt) {
      this.eventSubject.next({
        sessionId: row.sessionId,
        event: {
          type: 'preview.stopped',
          toolUseId,
          previewId: row.id,
          port: row.port,
          name: row.name,
          by,
        },
      });
    }
    this.changeSubject.next(row.sessionId);
    this.refreshStates();
    return this.toDto(stopped, this.requireEnabled());
  }

  /**
   * Re-checks the states of active previews and reports sessions whose
   * previews changed; runs every few seconds while there are any.
   */
  refreshStates(): void {
    const rows = this.config.previews ? this.previews.active() : [];
    const changed = new Set<string>();
    for (const row of rows) {
      const check = checkListener(row.port, this.policy, this.tables);
      const next = check.ok
        ? { state: 'running' as const, problem: null }
        : { state: 'unreachable' as const, problem: check.message };
      const previous = this.states.get(row.id);
      if (
        previous &&
        (previous.state !== next.state || previous.problem !== next.problem)
      ) {
        changed.add(row.sessionId);
      }
      this.states.set(row.id, next);
    }
    for (const id of [...this.states.keys()]) {
      if (!rows.some((row) => row.id === id)) {
        this.states.delete(id);
      }
    }
    for (const sessionId of changed) {
      this.changeSubject.next(sessionId);
    }
    if (rows.length > 0) {
      this.startMonitor();
    } else {
      this.stopMonitor();
    }
  }

  private startMonitor(): void {
    if (!this.timer) {
      this.timer = setInterval(
        () => this.refreshStates(),
        PREVIEW_STATE_INTERVAL_MS,
      );
      this.timer.unref();
    }
  }

  private stopMonitor(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private toDto(row: PreviewRow, settings: PreviewConfig): PreviewDto {
    const state = row.stoppedAt
      ? { state: 'stopped' as const, problem: null }
      : (this.states.get(row.id) ?? {
          state: 'unreachable' as const,
          problem: null,
        });
    return {
      id: row.id,
      sessionId: row.sessionId,
      port: row.port,
      name: row.name,
      url: previewUrl(settings, row.label),
      ...state,
      createdAt: row.createdAt.toISOString(),
      stoppedAt: row.stoppedAt?.toISOString() ?? null,
      stoppedBy: row.stoppedBy ?? null,
    };
  }

  private requireEnabled(): PreviewConfig {
    if (!this.config.previews) {
      throw new BadRequestException(
        'Previews are not configured on this server (PREVIEW_URL)',
      );
    }
    return this.config.previews;
  }

  /** Stops the session user's processes listening on the ports. */
  private stopListeners(ports: number[]): Promise<void> {
    const command = this.launcher.command('session', process.execPath, [
      stopListenersScript(),
      String(STOP_GRACE_MS),
      ...ports.map(String),
    ]);
    return new Promise((resolve) => {
      execFile(
        command.command,
        command.args,
        {
          cwd: '/',
          env: this.launcher.environment('session'),
          timeout: STOP_GRACE_MS + 10_000,
        },
        (error, stdout) => {
          if (error) {
            this.logger.warn(
              `Could not stop the dev servers on ports ${ports.join(', ')}: ${error.message}`,
            );
          } else {
            this.logger.log(
              `Stopped dev servers on ports ${ports.join(', ')}: ${stdout.trim()}`,
            );
          }
          resolve();
        },
      );
    });
  }
}
