import { SessionFileAccess } from '../../files/session-file-access';
import { ShownFilesService } from '../../shown-files/shown-files.service';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { type AppConfig, testAppConfig } from '../../config/app-config';
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
import { RepositoryAdditions } from '../repository-additions';
import { SessionWorkspaceService } from '../session-workspace.service';
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../../agent/tool-approval';
import { UserToolApprover } from '../../sessions/user-tool-approver';
import { FakeGitHub } from '../../github/testing/fake-github';
import { SessionAgentSupportService } from '../../sessions/session-agent-support';
import { SessionAutomationHooks } from '../../sessions/session-automation-hooks';
import { MessageContextRepository } from '../../sessions/message-context.repository';
import { SessionGitService } from '../../sessions/session-git.service';
import { RepositoryCredentials } from '../../repositories/repository-credentials';
import { SettingsService } from '../../settings/settings.service';
import { SetupScriptRunner } from '../setup-script-runner';

/**
 * The real approver, recording the requests; with `autoAnswer` set it
 * answers every request right away, as a user would in the dialog.
 */
export class RecordingApprover extends UserToolApprover {
  readonly requests: ToolApprovalRequest[] = [];
  autoAnswer: Record<string, unknown> | null = null;

  override decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    this.requests.push(request);
    return super.decide({
      ...request,
      onRequest: (event) => {
        request.onRequest(event);
        const answer = this.autoAnswer;
        if (answer) {
          queueMicrotask(() =>
            this.respond(request.sessionId, event.requestId, answer),
          );
        }
      },
    });
  }
}

/** Commit identity of the tests. */
export const TEST_IDENTITY = {
  name: 'Test Author',
  email: 'author@example.com',
};

/** Settings with the test commit identity. */
export function withTestIdentity(settings: SettingsService): SettingsService {
  settings.update({
    gitAuthorName: TEST_IDENTITY.name,
    gitAuthorEmail: TEST_IDENTITY.email,
  });
  return settings;
}

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
  readonly settings = withTestIdentity(new SettingsService(this.db));
  readonly github = new FakeGitHub();
  readonly credentials = new RepositoryCredentials(
    this.github.service,
    this.repositoryRecords,
  );
  readonly events: SessionEventEnvelope[] = [];
  readonly config: AppConfig = testAppConfig(this.dir);
  readonly approver = new RecordingApprover();
  /** Hooks for the PR automation (set by its tests). */
  readonly hooks = new SessionAutomationHooks();
  repositories!: RepositoriesService;
  workspaces!: SessionWorkspaceService;
  additions!: RepositoryAdditions;
  sessionGit!: SessionGitService;
  support!: SessionAgentSupportService;
  service!: SessionsService;
  shownFiles!: ShownFilesService;

  /** (Re)creates the services on the same database, like a restart. */
  async start(): Promise<SessionsService> {
    this.repositories = new RepositoriesService(
      this.config,
      this.repositoryRecords,
      this.git,
      this.settings,
      this.credentials,
      this.github.service,
    );
    this.workspaces = new SessionWorkspaceService(
      this.config,
      this.sessions,
      this.repositories,
      this.git,
      new SetupScriptRunner(),
      this.settings,
    );
    this.workspaces.onModuleInit();
    this.additions = new RepositoryAdditions(this.repositories);
    this.sessionGit = new SessionGitService(
      this.sessions,
      this.repositoryRecords,
      this.credentials,
      this.git,
      this.github.service,
    );
    this.shownFiles = new ShownFilesService(
      this.config,
      this.db,
      this.sessions,
      new SessionFileAccess(),
    );
    await this.shownFiles.onModuleInit();
    this.support = new SessionAgentSupportService(
      this.config,
      this.sessionGit,
      this.git,
      this.shownFiles,
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
      this.approver,
      this.support,
      undefined,
      undefined,
      this.shownFiles,
      undefined,
      new MessageContextRepository(this.db),
      this.hooks,
      undefined,
      this.additions,
    );
    const service = this.service;
    this.shownFiles.shown$.subscribe(({ sessionId, toolUseId, file }) =>
      service.recordEvent(sessionId, { type: 'file.shown', toolUseId, file }),
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
    // Let the process start (when the session runs).
    await waitFor(() => {
      const record = this.sessions.require(sessionId);
      const cwd = record.directories[0]?.path;
      return (
        record.status !== 'running' ||
        this.runner.runs.some((run) => run.options.cwd === cwd)
      );
    });
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
    this.workspaces?.onModuleDestroy();
    this.db.$client.close();
    this.sandbox.cleanup();
  }
}
