import { Injectable } from '@nestjs/common';

/**
 * The working directory each session's running Claude Code process was
 * started in. After `switch_directory` the stored working directory changes
 * at once, but the process keeps its own until it restarts; what refers to
 * paths for Claude (`@` mentions) must use the process's.
 */
@Injectable()
export class RunningDirectories {
  private readonly cwds = new Map<string, string>();

  set(sessionId: string, cwd: string): void {
    this.cwds.set(sessionId, cwd);
  }

  clear(sessionId: string): void {
    this.cwds.delete(sessionId);
  }

  /** The running process's working directory; `null` without a process. */
  get(sessionId: string): string | null {
    return this.cwds.get(sessionId) ?? null;
  }
}
