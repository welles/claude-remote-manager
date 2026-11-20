import { Injectable } from '@nestjs/common';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadAgentSdk } from './sdk-agent-runner';

/** Reads the conversation of a Claude Code session from its transcript. */
export abstract class TranscriptReader {
  /**
   * Messages of the session in order; empty if the transcript does not
   * exist. `cwd` is the directory Claude Code started the session in,
   * which selects the project folder the transcript lives in; with
   * `anywhere` (the working directory was switched), all project folders
   * are searched when it is not there.
   */
  abstract read(
    sdkSessionId: string,
    cwd: string,
    anywhere?: boolean,
  ): Promise<SessionMessage[]>;

  /** Whether Claude Code has a transcript for this session ID. */
  abstract exists(
    sdkSessionId: string,
    cwd: string,
    anywhere?: boolean,
  ): Promise<boolean>;

  /**
   * Size and modification time of the transcript, to tell whether it
   * changed; `null` if there is none.
   */
  abstract stamp(
    sdkSessionId: string,
    cwd: string,
    anywhere?: boolean,
  ): Promise<string | null>;
}

@Injectable()
export class SdkTranscriptReader implements TranscriptReader {
  async read(
    sdkSessionId: string,
    cwd: string,
    anywhere = false,
  ): Promise<SessionMessage[]> {
    const sdk = await loadAgentSdk();
    const messages = await sdk.getSessionMessages(sdkSessionId, { dir: cwd });
    if (
      messages.length > 0 ||
      !anywhere ||
      (await this.info(sdkSessionId, cwd))
    ) {
      return messages;
    }
    return sdk.getSessionMessages(sdkSessionId);
  }

  async exists(
    sdkSessionId: string,
    cwd: string,
    anywhere = false,
  ): Promise<boolean> {
    return (await this.find(sdkSessionId, cwd, anywhere)) !== undefined;
  }

  async stamp(
    sdkSessionId: string,
    cwd: string,
    anywhere = false,
  ): Promise<string | null> {
    const info = await this.find(sdkSessionId, cwd, anywhere);
    return info ? `${info.fileSize ?? '?'}@${info.lastModified}` : null;
  }

  private async info(sdkSessionId: string, cwd?: string) {
    const sdk = await loadAgentSdk();
    return sdk.getSessionInfo(sdkSessionId, cwd ? { dir: cwd } : undefined);
  }

  /** The transcript in `cwd`'s project folder, else (`anywhere`) in any. */
  private async find(sdkSessionId: string, cwd: string, anywhere: boolean) {
    return (
      (await this.info(sdkSessionId, cwd)) ??
      (anywhere ? await this.info(sdkSessionId) : undefined)
    );
  }
}
