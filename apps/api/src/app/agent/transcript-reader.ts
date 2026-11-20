import { Injectable } from '@nestjs/common';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadAgentSdk } from './sdk-agent-runner';

/** Reads the conversation of a Claude Code session from its transcript. */
export abstract class TranscriptReader {
  /**
   * Messages of the session in order; empty if the transcript does not
   * exist. `cwd` is the directory Claude Code started the session in,
   * which selects the project folder the transcript lives in; when it is
   * not there (e.g. after a switch of the working directory), all project
   * folders are searched.
   */
  abstract read(sdkSessionId: string, cwd: string): Promise<SessionMessage[]>;

  /** Whether Claude Code has a transcript for this session ID. */
  abstract exists(sdkSessionId: string, cwd: string): Promise<boolean>;

  /**
   * Size and modification time of the transcript, to tell whether it
   * changed; `null` if there is none.
   */
  abstract stamp(sdkSessionId: string, cwd: string): Promise<string | null>;
}

@Injectable()
export class SdkTranscriptReader implements TranscriptReader {
  async read(sdkSessionId: string, cwd: string): Promise<SessionMessage[]> {
    const sdk = await loadAgentSdk();
    const messages = await sdk.getSessionMessages(sdkSessionId, { dir: cwd });
    return messages.length > 0 || (await this.info(sdkSessionId, cwd))
      ? messages
      : sdk.getSessionMessages(sdkSessionId);
  }

  async exists(sdkSessionId: string, cwd: string): Promise<boolean> {
    return (await this.find(sdkSessionId, cwd)) !== undefined;
  }

  async stamp(sdkSessionId: string, cwd: string): Promise<string | null> {
    const info = await this.find(sdkSessionId, cwd);
    return info ? `${info.fileSize ?? '?'}@${info.lastModified}` : null;
  }

  private async info(sdkSessionId: string, cwd?: string) {
    const sdk = await loadAgentSdk();
    return sdk.getSessionInfo(sdkSessionId, cwd ? { dir: cwd } : undefined);
  }

  /** The transcript in `cwd`'s project folder, else in any. */
  private async find(sdkSessionId: string, cwd: string) {
    return (
      (await this.info(sdkSessionId, cwd)) ?? (await this.info(sdkSessionId))
    );
  }
}
