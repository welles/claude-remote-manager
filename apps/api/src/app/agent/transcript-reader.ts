import { Injectable } from '@nestjs/common';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadAgentSdk } from './sdk-agent-runner';

/** Reads the conversation of a Claude Code session from its transcript. */
export abstract class TranscriptReader {
  /**
   * Messages of the session in order; empty if the transcript does not
   * exist. `cwd` is the session's working directory, which selects the
   * project directory the transcript lives in.
   */
  abstract read(sdkSessionId: string, cwd: string): Promise<SessionMessage[]>;

  /** Whether Claude Code has a transcript for this session ID. */
  abstract exists(sdkSessionId: string, cwd: string): Promise<boolean>;
}

@Injectable()
export class SdkTranscriptReader implements TranscriptReader {
  async read(sdkSessionId: string, cwd: string): Promise<SessionMessage[]> {
    const sdk = await loadAgentSdk();
    return sdk.getSessionMessages(sdkSessionId, { dir: cwd });
  }

  async exists(sdkSessionId: string, cwd: string): Promise<boolean> {
    const sdk = await loadAgentSdk();
    return (await sdk.getSessionInfo(sdkSessionId, { dir: cwd })) !== undefined;
  }
}
