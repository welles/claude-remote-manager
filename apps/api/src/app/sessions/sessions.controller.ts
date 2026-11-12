import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type {
  CreateSessionRequest,
  SessionDto,
  SessionListResponse,
} from '@claude-remote-manager/shared-types';
import { SessionsService } from './sessions.service';

/**
 * Session management. Live events and messages go over the WebSocket
 * (`/api/ws`); sending and interrupting are available here as well.
 */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(): SessionListResponse {
    return { sessions: this.sessions.list() };
  }

  @Get(':id')
  get(@Param('id') id: string): SessionDto {
    return this.sessions.get(id);
  }

  @Post()
  create(@Body() request: CreateSessionRequest): Promise<SessionDto> {
    return this.sessions.create(request);
  }

  @Post(':id/messages')
  @HttpCode(202)
  async send(
    @Param('id') id: string,
    @Body() body: { id?: string; text: string },
  ): Promise<void> {
    await this.sessions.send(id, body);
  }

  /** Stops the session's process and marks it finished. */
  @Post(':id/end')
  @HttpCode(200)
  end(@Param('id') id: string): Promise<SessionDto> {
    return this.sessions.end(id);
  }

  @Post(':id/interrupt')
  @HttpCode(202)
  interrupt(@Param('id') id: string): Promise<void> {
    return this.sessions.interrupt(id);
  }
}
