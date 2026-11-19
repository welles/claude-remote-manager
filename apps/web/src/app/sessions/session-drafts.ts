import { Injectable } from '@angular/core';

/**
 * Unsent text of the session inputs, by session, for the app's lifetime:
 * the text is still there after visiting the session's Files or Changes
 * page or another session.
 */
@Injectable({ providedIn: 'root' })
export class SessionDrafts {
  private readonly drafts = new Map<string, string>();

  get(sessionId: string): string {
    return this.drafts.get(sessionId) ?? '';
  }

  set(sessionId: string, text: string): void {
    if (text) {
      this.drafts.set(sessionId, text);
    } else {
      this.drafts.delete(sessionId);
    }
  }
}
