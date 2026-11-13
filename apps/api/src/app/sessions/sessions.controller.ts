import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  CreateSessionRequest,
  MessageContextResponse,
  MessageReferenceRequest,
  PendingPermissionRequestsResponse,
  PermissionResponse,
  PermissionResponseResult,
  SessionDto,
  SessionListResponse,
  UpdateSessionRequest,
} from '@claude-remote-manager/shared-types';
import { SessionGitService } from './session-git.service';
import { SessionsService } from './sessions.service';

/**
 * Session management. Live events and messages go over the WebSocket
 * (`/api/ws`); sending and interrupting are available here as well.
 */
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly git: SessionGitService,
  ) {}

  @Get()
  list(): SessionListResponse {
    return { sessions: this.sessions.list() };
  }

  @Get(':id')
  get(@Param('id') id: string): SessionDto {
    const session = this.sessions.get(id);
    // Open pull requests are re-read from GitHub in the background (at
    // most once a minute); changes arrive as session updates.
    if (session.pullRequests.some((pull) => pull.state === 'open')) {
      void this.git.refreshPullRequests(id).catch(() => undefined);
    }
    return session;
  }

  @Post()
  create(@Body() request: CreateSessionRequest): Promise<SessionDto> {
    return this.sessions.create(request);
  }

  @Post(':id/messages')
  @HttpCode(202)
  async send(
    @Param('id') id: string,
    @Body()
    body: {
      id?: string;
      text: string;
      attachmentIds?: string[];
      references?: MessageReferenceRequest[];
    },
  ): Promise<void> {
    await this.sessions.send(id, body);
  }

  /** The context the app gave Claude with a message (GitHub content). */
  @Get(':id/messages/:messageId/context')
  messageContext(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): MessageContextResponse {
    return this.sessions.messageContext(id, messageId);
  }

  /** Stops the session's process and marks it finished. */
  @Post(':id/end')
  @HttpCode(200)
  end(@Param('id') id: string): Promise<SessionDto> {
    return this.sessions.end(id);
  }

  /** Sends the first message held back after a failed setup script. */
  @Post(':id/pending-message/send')
  @HttpCode(200)
  sendPending(@Param('id') id: string): Promise<SessionDto> {
    return this.sessions.sendPending(id);
  }

  /** Runs the failed setup scripts again, then sends the first message. */
  @Post(':id/setup/rerun')
  @HttpCode(200)
  rerunSetup(@Param('id') id: string): Promise<SessionDto> {
    return this.sessions.rerunSetup(id);
  }

  @Post(':id/interrupt')
  @HttpCode(202)
  interrupt(@Param('id') id: string): Promise<void> {
    return this.sessions.interrupt(id);
  }

  /** Changes the model or permission mode, also while the session runs. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateSessionRequest,
  ): Promise<SessionDto> {
    return this.sessions.update(id, body);
  }

  /** Approval requests of the session that wait for an answer. */
  @Get(':id/permission-requests')
  pendingPermissions(
    @Param('id') id: string,
  ): PendingPermissionRequestsResponse {
    return { requests: this.sessions.pendingPermissions(id) };
  }

  /**
   * Answers an approval request (also without an open WebSocket, e.g. from
   * a notification). A request answered before is not changed.
   */
  @Post(':id/permission-requests/:requestId')
  @HttpCode(200)
  respondToPermission(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: PermissionResponse,
  ): Promise<PermissionResponseResult> {
    return this.sessions.respondToPermission(id, requestId, body);
  }

  /** Removes a queued message before it goes to Claude. */
  @Delete(':id/queued-messages/:messageId')
  @HttpCode(204)
  unqueue(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.sessions.unqueue(id, messageId);
  }
}
