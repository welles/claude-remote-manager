import { Logger, Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { GitHubReferencesModule } from '../github-references/github-references.module';
import { MessageContextRepository } from './message-context.repository';
import { PreviewsModule } from '../previews/previews.module';
import { PreviewsService } from '../previews/previews.service';
import { ShownFilesModule } from '../shown-files/shown-files.module';
import { ShownFilesService } from '../shown-files/shown-files.service';
import { ToolApprover } from '../agent/tool-approval';
import {
  SessionAgentSupport,
  SessionAgentSupportService,
} from './session-agent-support';
import { SessionAutomationHooks } from './session-automation-hooks';
import { SessionGitController } from './session-git.controller';
import { SessionGitHubTokensController } from './session-github-tokens.controller';
import { SessionGitHubTokensService } from './session-github-tokens.service';
import { SessionTokens } from './session-tokens';
import { SessionGitService } from './session-git.service';
import { AgentRunner } from '../agent/agent-runner';
import {
  AgentEngines,
  CODEX_CAPABILITIES,
  EnginesController,
} from '../agent/agent-engines';
import {
  CodexRunner,
  CodexTranscriptReader,
} from '../agent/codex/codex-runner';
import { codexBaseHome } from '../agent/codex/codex-home';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  PROCESS_LAUNCHER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { SdkAgentRunner } from '../agent/sdk-agent-runner';
import {
  SdkTranscriptReader,
  TranscriptReader,
} from '../agent/transcript-reader';
import { LimitsModule } from '../limits/limits.module';
import { LimitsService } from '../limits/limits.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import { RepositoryAdditions } from '../workspaces/repository-additions';
import { SessionWorkspaceService } from '../workspaces/session-workspace.service';
import { SetupScriptRunner } from '../workspaces/setup-script-runner';
import { SessionDiffController } from '../diffs/session-diff.controller';
import { SessionDiffService } from '../diffs/session-diff.service';
import { SessionCommitsService } from '../diffs/session-commits.service';
import { FileMentionsService } from '../files/file-mentions.service';
import { RunningDirectories } from './running-directories';
import {
  SessionBrowseController,
  SessionFilesController,
} from '../files/files.controller';
import { SessionFileAccess } from '../files/session-file-access';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionManagementController } from './session-management.controller';
import { SessionManagementService } from './session-management.service';
import { SessionRemoteBranches } from './session-remote-branches';
import { WorkspaceController } from '../workspaces/workspace.controller';
import { WorkspaceOrphansService } from '../workspaces/workspace-orphans.service';
import { SessionsGateway } from './sessions.gateway';
import { SessionsService } from './sessions.service';
import { AccountsService } from '../accounts/accounts.service';
import { UsageRepository } from './usage.repository';
import { UserToolApprover } from './user-tool-approver';
import { ViewerPresence } from './viewer-presence';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';
import { SlashCommandsController } from './slash-commands.controller';
import { SlashCommandsService } from './slash-commands.service';

const logger = new Logger('SessionsModule');

@Module({
  imports: [
    AttachmentsModule,
    GitHubReferencesModule,
    LimitsModule,
    PreviewsModule,
    RepositoriesModule,
    ShownFilesModule,
  ],
  controllers: [
    SessionsController,
    SessionManagementController,
    WorkspaceController,
    SessionGitController,
    SessionGitHubTokensController,
    SessionDiffController,
    SessionFilesController,
    SessionBrowseController,
    ModelsController,
    SlashCommandsController,
    EnginesController,
  ],
  providers: [
    SessionRepository,
    SessionEventRepository,
    MessageContextRepository,
    UsageRepository,
    SessionsService,
    SessionManagementService,
    SessionRemoteBranches,
    WorkspaceOrphansService,
    SessionsGateway,
    { provide: ViewerPresence, useValue: new ViewerPresence() },
    SessionGitService,
    { provide: SessionTokens, useValue: new SessionTokens() },
    SessionGitHubTokensService,
    {
      provide: SessionAutomationHooks,
      useValue: new SessionAutomationHooks(),
    },
    { provide: SessionAgentSupport, useClass: SessionAgentSupportService },
    { provide: ToolApprover, useValue: new UserToolApprover() },
    ModelsService,
    SlashCommandsService,
    SessionWorkspaceService,
    RepositoryAdditions,
    SetupScriptRunner,
    SessionFileAccess,
    SessionDiffService,
    SessionCommitsService,
    FileMentionsService,
    RunningDirectories,
    { provide: AgentRunner, useClass: SdkAgentRunner },
    {
      provide: AgentEngines,
      inject: [APP_CONFIG, PROCESS_LAUNCHER, AgentRunner, TranscriptReader],
      useFactory: (
        config: AppConfig,
        launcher: ProcessLauncher,
        claudeCode: AgentRunner,
        claudeTranscripts: TranscriptReader,
      ) => {
        const engines = new AgentEngines(claudeCode, claudeTranscripts);
        if (config.codexExecutable) {
          // Offered where the server has Codex.
          const baseHome = codexBaseHome(launcher);
          const codex = new CodexRunner(
            {
              executable: config.codexExecutable,
              baseHome,
              instructionsFile: config.codexInstructionsFile,
            },
            launcher,
          );
          engines.register('codex', {
            runner: codex,
            transcripts: new CodexTranscriptReader(codex, baseHome, launcher),
            capabilities: CODEX_CAPABILITIES,
            fixedTools: true,
            namesSessions: true,
          });
        }
        return engines;
      },
    },
    { provide: TranscriptReader, useClass: SdkTranscriptReader },
  ],
  exports: [
    SessionsService,
    AgentEngines,
    SessionDiffService,
    UsageRepository,
    AgentRunner,
    ViewerPresence,
    SessionRepository,
    SessionGitService,
    SessionAutomationHooks,
    TranscriptReader,
  ],
})
export class SessionsModule {
  constructor(
    sessions: SessionsService,
    git: SessionGitService,
    limits: LimitsService,
    shownFiles: ShownFilesService,
    previews: PreviewsService,
    commits: SessionCommitsService,
    accounts: AccountsService,
    engines: AgentEngines,
  ) {
    // Files shown by the app's tool belong in the session's log.
    shownFiles.shown$.subscribe(({ sessionId, toolUseId, file }) =>
      sessions.recordEvent(sessionId, { type: 'file.shown', toolUseId, file }),
    );
    // Previews exposed and stopped belong in the log too; their states
    // are part of the session.
    previews.events$.subscribe(({ sessionId, event }) =>
      sessions.recordEvent(sessionId, event),
    );
    previews.changes$.subscribe((id) => {
      sessions.previewsChanged(id);
      sessions.publishUpdate(id);
    });
    // New commits on session branches show in the history, on the tool
    // call that made them.
    sessions.events$.subscribe(({ sessionId, event }) =>
      commits.observe(sessionId, event),
    );
    commits.added$.subscribe(({ sessionId, event }) => {
      try {
        sessions.recordEvent(sessionId, event);
      } catch (error) {
        logger.warn(
          `Could not record new commits of ${sessionId}: ${String(error)}`,
        );
      }
    });
    // Pushes and pull requests change what the session view shows.
    git.changes$.subscribe((id) => sessions.publishUpdate(id));
    // Limits are also read when no session runs (see LimitsService).
    limits.setPlanUsageSource((accountId) =>
      accounts.withAccount(
        accountId,
        (account) => {
          // The engine of the account's provider reads its limits.
          const engine = engines.forProvider(
            accounts.providerOf(accountId) ?? 'claude',
          );
          if (!engine) {
            throw new Error('No engine for this account here');
          }
          return engines
            .runner(engine)
            .probe((probe) => probe.planUsage(), account);
        },
        { exact: true },
      ),
    );
  }
}
