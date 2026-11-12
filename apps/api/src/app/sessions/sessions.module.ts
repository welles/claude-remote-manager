import { Module } from '@nestjs/common';
import { AgentRunner } from '../agent/agent-runner';
import { SdkAgentRunner } from '../agent/sdk-agent-runner';
import {
  SdkTranscriptReader,
  TranscriptReader,
} from '../agent/transcript-reader';
import { LimitsModule } from '../limits/limits.module';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsGateway } from './sessions.gateway';
import { SessionsService } from './sessions.service';
import { UsageRepository } from './usage.repository';

@Module({
  imports: [LimitsModule],
  controllers: [SessionsController],
  providers: [
    SessionRepository,
    SessionEventRepository,
    UsageRepository,
    SessionsService,
    SessionsGateway,
    { provide: AgentRunner, useClass: SdkAgentRunner },
    { provide: TranscriptReader, useClass: SdkTranscriptReader },
  ],
})
export class SessionsModule {}
