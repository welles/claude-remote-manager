import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { GitHubReferencesModule } from '../github-references/github-references.module';
import { MessageContextRepository } from './message-context.repository';
import { PreviewsModule } from '../previews/previews.module';
import { PreviewsService } from '../previews/previews.service';
import { ShownFilesModule } from '../shown-files/shown-files.module';
import { ShownFilesService } from '../shown-files/shown-files.service';
import { ToolApprover } from '../agent/tool-approval';
import { ApprovalGrants } from './approval-grants';
import { GitCredentialsController } from './git-credentials.controller';
import { GitCredentialsService } from './git-credentials.service';
import {
  SessionAgentSupport,
  SessionAgentSupportService,
} from './session-agent-support';
import { SessionCredentials } from './session-credentials';
import { SessionAutomationHooks } from './session-automation-hooks';
import { SessionGitController } from './session-git.controller';
import { SessionGitService } from './session-git.service';
import { AgentRunner } from '../agent/agent-runner';
import { SdkAgentRunner } from '../agent/sdk-agent-runner';
import {
  SdkTranscriptReader,
  TranscriptReader,
} from '../agent/transcript-reader';
import { LimitsModule } from '../limits/limits.module';
import { LimitsService } from '../limits/limits.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import { SessionWorkspaceService } from '../workspaces/session-workspace.service';
import { SetupScriptRunner } from '../workspaces/setup-script-runner';
import { SessionDiffController } from '../diffs/session-diff.controller';
import { SessionDiffService } from '../diffs/session-diff.service';
import { FileMentionsService } from '../files/file-mentions.service';
import { SessionFilesController } from '../files/files.controller';
import { SessionFileAccess } from '../files/session-file-access';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsGateway } from './sessions.gateway';
import { SessionsService } from './sessions.service';
import { UsageRepository } from './usage.repository';
import { UserToolApprover } from './user-tool-approver';
import { ViewerPresence } from './viewer-presence';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

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
    SessionGitController,
    SessionDiffController,
    SessionFilesController,
    GitCredentialsController,
    ModelsController,
  ],
  providers: [
    SessionRepository,
    SessionEventRepository,
    MessageContextRepository,
    UsageRepository,
    SessionsService,
    SessionsGateway,
    { provide: ViewerPresence, useValue: new ViewerPresence() },
    SessionGitService,
    GitCredentialsService,
    { provide: SessionCredentials, useValue: new SessionCredentials() },
    { provide: ApprovalGrants, useValue: new ApprovalGrants() },
    {
      provide: SessionAutomationHooks,
      useValue: new SessionAutomationHooks(),
    },
    { provide: SessionAgentSupport, useClass: SessionAgentSupportService },
    { provide: ToolApprover, useValue: new UserToolApprover() },
    ModelsService,
    SessionWorkspaceService,
    SetupScriptRunner,
    SessionFileAccess,
    SessionDiffService,
    FileMentionsService,
    { provide: AgentRunner, useClass: SdkAgentRunner },
    { provide: TranscriptReader, useClass: SdkTranscriptReader },
  ],
  exports: [
    SessionsService,
    ViewerPresence,
    SessionRepository,
    SessionGitService,
    SessionAutomationHooks,
  ],
})
export class SessionsModule {
  constructor(
    sessions: SessionsService,
    git: SessionGitService,
    limits: LimitsService,
    runner: AgentRunner,
    shownFiles: ShownFilesService,
    previews: PreviewsService,
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
    // Pushes and pull requests change what the session view shows.
    git.changes$.subscribe((id) => sessions.publishUpdate(id));
    // Limits are also read when no session runs (see LimitsService).
    limits.setPlanUsageSource(() => runner.probe((probe) => probe.planUsage()));
  }
}
