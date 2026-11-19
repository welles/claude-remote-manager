/**
 * Claude Code's slash commands and skills for `/` autocomplete in the
 * input (`GET /api/sessions/:id/slash-commands`).
 */

/** A command `/name` the user can start a message with. */
export interface SlashCommandOption {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** Hint for its arguments (e.g. `<file>`), empty if none. */
  argumentHint: string;
  /** Other names that run it. */
  aliases: string[];
  /** Claude Code's own (not a skill or command of the user, project or a plugin). */
  builtin: boolean;
}

export interface SlashCommandsResponse {
  commands: SlashCommandOption[];
  /**
   * `session`: what the session's Claude Code reported (with the project's
   * commands and skills); `user`: the user's and Claude Code's own only,
   * as long as the session has not run yet.
   */
  source: 'session' | 'user';
}
