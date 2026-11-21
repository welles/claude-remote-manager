import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  AddSessionRepositoryRequest,
  CreateSessionRequest,
  MessageContextResponse,
  MessageReferenceRequest,
  PendingPermissionRequestsResponse,
  PermissionResponse,
  PermissionResponseResult,
  SessionDto,
  SessionListFilter,
  SessionListResponse,
  UpdateSessionRequest,
} from '@claude-remote-manager/shared-types';
import { SessionGitService } from './session-git.service';
import { branchParam } from './session-clones';
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

  /** `?archived=only` lists archived sessions, `include` all. */
  @Get()
  list(@Query('archived') archived?: string): SessionListResponse {
    const filter: SessionListFilter =
      archived === 'only' || archived === 'include' ? archived : 'exclude';
    return { sessions: this.sessions.list(filter) };
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

  /**
   * Continues a session the usage limit stopped now instead of when the
   * limit resets.
   */
  @Post(':id/limit-wait/resume')
  @HttpCode(200)
  async resumeAfterLimit(@Param('id') id: string): Promise<SessionDto> {
    await this.sessions.resumeAfterLimit(id);
    return this.sessions.get(id);
  }

  /** Does not continue a session the usage limit stopped by itself. */
  @Delete(':id/limit-wait')
  @HttpCode(200)
  async cancelLimitWait(@Param('id') id: string): Promise<SessionDto> {
    await this.sessions.cancelLimitWait(id);
    return this.sessions.get(id);
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

  /**
   * Adds a registered repository to the session: its clone and setup
   * script are prepared in the background (see `SessionsService`).
   */
  @Post(':id/repositories')
  @HttpCode(202)
  addRepository(
    @Param('id') id: string,
    @Body() body: AddSessionRepositoryRequest,
  ): Promise<SessionDto> {
    return this.sessions.addRepository(id, body);
  }

  /** Clones a failed addition again, or runs its failed setup again. */
  @Post(':id/repositories/:repositoryId/addition/retry')
  @HttpCode(202)
  retryAddition(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
    @Query('branch') branch?: string,
  ): Promise<SessionDto> {
    return this.sessions.retryAddition(id, repositoryId, branchParam(branch));
  }

  /** Gives Claude an added repository whose setup script failed. */
  @Post(':id/repositories/:repositoryId/addition/accept')
  @HttpCode(200)
  acceptAddition(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
    @Query('branch') branch?: string,
  ): Promise<SessionDto> {
    return this.sessions.acceptAddition(id, repositoryId, branchParam(branch));
  }

  /** Removes an addition that failed or is held (and its clone). */
  @Post(':id/repositories/:repositoryId/addition/remove')
  @HttpCode(200)
  removeAddition(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
    @Query('branch') branch?: string,
  ): Promise<SessionDto> {
    return this.sessions.removeAddition(id, repositoryId, branchParam(branch));
  }

  /** Stops the running turn and sends all queued messages right away. */
  @Post(':id/queued-messages/send')
  @HttpCode(204)
  sendQueuedNow(@Param('id') id: string): Promise<void> {
    return this.sessions.sendQueuedNow(id, null);
  }

  /** Stops the running turn and sends this queued message right away. */
  @Post(':id/queued-messages/:messageId/send')
  @HttpCode(204)
  sendQueuedMessageNow(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.sessions.sendQueuedNow(id, messageId);
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
