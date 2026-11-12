import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import type { AppConfig } from '../../config/app-config';
import { openDatabase, type AppDatabase } from '../../db/database';
import { GitService } from '../../git/git.service';
import { createOrigin, gitSandbox } from '../../git/testing/git-fixtures';
import { LimitsService } from '../../limits/limits.service';
import { RepositoriesService } from '../../repositories/repositories.service';
import { RepositoryRepository } from '../../repositories/repository.repository';
import { SessionEventRepository } from '../../sessions/session-event.repository';
import { SessionRepository } from '../../sessions/session.repository';
import {
  SessionsService,
  type SessionEventEnvelope,
} from '../../sessions/sessions.service';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  waitFor,
} from '../../sessions/testing/fake-agent';
import { UsageRepository } from '../../sessions/usage.repository';
import { SessionWorkspaceService } from '../session-workspace.service';
import { SetupScriptRunner } from '../setup-script-runner';

/**
 * Sessions service with real git, real setup scripts and real temporary
 * repositories; only Claude Code is faked.
 */
export class WorkspaceHarness {
  readonly sandbox = gitSandbox('crm-workspace-');
  readonly dir = this.sandbox.dir;
  readonly db: AppDatabase = openDatabase(':memory:');
  readonly git = new GitService();
  readonly runner = new FakeAgentRunner();
  readonly transcripts = new FakeTranscriptReader();
  readonly sessions = new SessionRepository(this.db);
  readonly repositoryRecords = new RepositoryRepository(this.db);
  readonly events: SessionEventEnvelope[] = [];
  readonly config: AppConfig = {
    dbDir: ':memory:',
    reposDir: join(this.dir, 'repos'),
    worktreesDir: join(this.dir, 'worktrees'),
    projectsDir: join(this.dir, 'projects'),
    setupScriptTimeoutMs: 10_000,
    sessionIdleTimeoutMs: 0,
    claudeExecutable: null,
    allowedOrigins: [],
    allowedHosts: [],
  };
  repositories!: RepositoriesService;
  workspaces!: SessionWorkspaceService;
  service!: SessionsService;

  /** (Re)creates the services on the same database, like a restart. */
  async start(): Promise<SessionsService> {
    this.repositories = new RepositoriesService(
      this.config,
      this.repositoryRecords,
      this.git,
    );
    this.workspaces = new SessionWorkspaceService(
      this.config,
      this.sessions,
      this.repositories,
      this.git,
      new SetupScriptRunner(),
    );
    this.service = new SessionsService(
      this.config,
      this.sessions,
      new UsageRepository(this.db),
      new SessionEventRepository(this.db),
      this.runner,
      this.transcripts,
      new LimitsService(),
      this.workspaces,
    );
    await this.service.onModuleInit();
    this.service.events$.subscribe((event) => this.events.push(event));
    return this.service;
  }

  /** A remote repository `origin/<owner>/<name>`, registered (not cloned). */
  async addRepository(
    owner: string,
    name: string,
    setupScript: string | null = null,
  ): Promise<{ id: string; origin: string; localPath: string }> {
    const origin = join(this.dir, 'origin', owner, name);
    await createOrigin(origin);
    const record = this.repositoryRecords.create({
      id: randomUUID(),
      owner,
      name,
      cloneUrl: origin,
      localPath: join(this.config.reposDir, owner, name),
      setupScript,
    });
    return { id: record.id, origin, localPath: record.localPath };
  }

  /** Waits until the session is no longer being prepared. */
  async prepared(sessionId: string): Promise<void> {
    await waitFor(
      () => this.sessions.require(sessionId).status !== 'preparing',
    );
    // Let the process start.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** Events of a session as they were published. */
  eventsOf(sessionId: string): SessionEvent[] {
    return this.events
      .filter((envelope) => envelope.sessionId === sessionId)
      .map((envelope) => envelope.event);
  }

  /** Events of one type of a session. */
  eventsOfType<T extends SessionEventInput['type']>(
    sessionId: string,
    type: T,
  ): Extract<SessionEvent, { type: T }>[] {
    return this.eventsOf(sessionId).filter(
      (event): event is Extract<SessionEvent, { type: T }> =>
        event.type === type,
    );
  }

  async close(): Promise<void> {
    await this.service?.onModuleDestroy();
    this.db.$client.close();
    this.sandbox.cleanup();
  }
}
