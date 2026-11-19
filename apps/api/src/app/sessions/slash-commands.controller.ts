import { Controller, Get, Param } from '@nestjs/common';
import type { SlashCommandsResponse } from '@claude-remote-manager/shared-types';
import { SessionsService } from './sessions.service';
import { SlashCommandsService } from './slash-commands.service';

/** Slash commands and skills for `/` autocomplete in the input. */
@Controller()
export class SlashCommandsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly commands: SlashCommandsService,
  ) {}

  /** Those of a session (its project's included once it ran). */
  @Get('sessions/:id/slash-commands')
  forSession(@Param('id') id: string): Promise<SlashCommandsResponse> {
    // Unknown sessions: 404.
    this.sessions.get(id);
    return this.commands.forSession(id);
  }

  /** The user's and Claude Code's own (for a new session). */
  @Get('slash-commands')
  forUser(): Promise<SlashCommandsResponse> {
    return this.commands.forSession(null);
  }
}
