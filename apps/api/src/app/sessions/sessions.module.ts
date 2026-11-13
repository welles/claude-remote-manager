import { Module } from '@nestjs/common';
import { ToolApprover } from '../agent/tool-approval';
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
import { LimitsService } from '../limits/limits.service';
import { RepositoriesModule } from '../repositories/repositories.module';
import { SessionWorkspaceService } from '../workspaces/session-workspace.service';
import { SetupScriptRunner } from '../workspaces/setup-script-runner';
import { SessionFileAccess } from '../files/session-file-access';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsGateway } from './sessions.gateway';
import { SessionsService } from './sessions.service';
import { UsageRepository } from './usage.repository';
import { UserToolApprover } from './user-tool-approver';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [LimitsModule, RepositoriesModule],
  controllers: [
    SessionsController,
    SessionGitController,
    GitCredentialsController,
    ModelsController,
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
    { provide: ToolApprover, useValue: new UserToolApprover() },
    ModelsService,
    SessionWorkspaceService,
    SetupScriptRunner,
    SessionFileAccess,
    { provide: AgentRunner, useClass: SdkAgentRunner },
    { provide: TranscriptReader, useClass: SdkTranscriptReader },
  ],
})
export class SessionsModule {
  constructor(
    sessions: SessionsService,
    git: SessionGitService,
    limits: LimitsService,
    runner: AgentRunner,
  ) {
    // Pushes and pull requests change what the session view shows.
    git.changes$.subscribe((id) => sessions.publishUpdate(id));
    // Limits are also read when no session runs (see LimitsService).
    limits.setPlanUsageSource(() => runner.probe((probe) => probe.planUsage()));
  }
}
