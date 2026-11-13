import { Module } from '@nestjs/common';
import { NoApprovalUiApprover, ToolApprover } from '../agent/tool-approval';
import { ApprovalGrants } from './approval-grants';
import { GitCredentialsController } from './git-credentials.controller';
import { GitCredentialsService } from './git-credentials.service';
import {
  SessionAgentSupport,
  SessionAgentSupportService,
} from './session-agent-support';
import { SessionCredentials } from './session-credentials';
import { SessionGitController } from './session-git.controller';
import { SessionGitService } from './session-git.service';
import { AgentRunner } from '../agent/agent-runner';
import { SdkAgentRunner } from '../agent/sdk-agent-runner';
import {
  SdkTranscriptReader,
  TranscriptReader,
} from '../agent/transcript-reader';
import { LimitsModule } from '../limits/limits.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { SessionWorkspaceService } from '../workspaces/session-workspace.service';
import { SetupScriptRunner } from '../workspaces/setup-script-runner';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsGateway } from './sessions.gateway';
import { SessionsService } from './sessions.service';
import { UsageRepository } from './usage.repository';

@Module({
  imports: [LimitsModule, RepositoriesModule],
  controllers: [
    SessionsController,
    SessionGitController,
    GitCredentialsController,
  ],
  providers: [
    SessionRepository,
    SessionEventRepository,
    UsageRepository,
    SessionsService,
    SessionsGateway,
    SessionGitService,
    GitCredentialsService,
    { provide: SessionCredentials, useValue: new SessionCredentials() },
    { provide: ApprovalGrants, useValue: new ApprovalGrants() },
    { provide: SessionAgentSupport, useClass: SessionAgentSupportService },
    // Replaced by the approval dialogs.
    { provide: ToolApprover, useClass: NoApprovalUiApprover },
    SessionWorkspaceService,
    SetupScriptRunner,
    { provide: AgentRunner, useClass: SdkAgentRunner },
    { provide: TranscriptReader, useClass: SdkTranscriptReader },
  ],
})
export class SessionsModule {
  constructor(sessions: SessionsService, git: SessionGitService) {
    // Pushes and pull requests change what the session view shows.
    git.changes$.subscribe((id) => sessions.publishUpdate(id));
  }
}
