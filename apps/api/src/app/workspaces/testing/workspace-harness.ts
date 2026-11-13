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
import { SessionWorkspaceService } from '../session-workspace.service';
import {
  NO_APPROVAL_UI_MESSAGE,
  ToolApprover,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from '../../agent/tool-approval';
import { FakeGitHub } from '../../github/testing/fake-github';
import { ApprovalGrants } from '../../sessions/approval-grants';
import { SessionAgentSupportService } from '../../sessions/session-agent-support';
import { SessionCredentials } from '../../sessions/session-credentials';
import { SessionGitService } from '../../sessions/session-git.service';
import { RepositoryCredentials } from '../../repositories/repository-credentials';
import { SettingsService } from '../../settings/settings.service';
import { SetupScriptRunner } from '../setup-script-runner';

/**
 * Stands in for the approval dialogs: answers with `answer`, which denies
 * like the app does today unless a test replaces it.
 */
export class FakeApprover extends ToolApprover {
  readonly requests: ToolApprovalRequest[] = [];
  answer: (request: ToolApprovalRequest) => ToolApprovalDecision = () => ({
    behavior: 'deny',
    message: NO_APPROVAL_UI_MESSAGE,
    reason: 'no_approval_ui',
  });

  async decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    this.requests.push(request);
    return this.answer(request);
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
  readonly sessionCredentials = new SessionCredentials();
  readonly grants = new ApprovalGrants();
  readonly approver = new FakeApprover();
  repositories!: RepositoriesService;
  workspaces!: SessionWorkspaceService;
  sessionGit!: SessionGitService;
  support!: SessionAgentSupportService;
  service!: SessionsService;

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
    this.sessionGit = new SessionGitService(
      this.sessions,
      this.repositoryRecords,
      this.credentials,
      this.git,
      this.github.service,
    );
    this.support = new SessionAgentSupportService(
      this.config,
      this.sessionCredentials,
      this.grants,
      this.sessionGit,
      this.git,
      this.github.installationTokens,
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
