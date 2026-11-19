import { Component, input, output, signal } from '@angular/core';
import { AppIcon } from '../ui/icon';
import type { ConversationItem } from './conversation';

/**
 * Messages waiting for the running turn to end, collapsed to one line
 * ("2 queued · sent when the turn ends") that expands to the list, where
 * each can be removed. "Send now" (all, or one in the list) stops the turn
 * and sends them right away.
 */
@Component({
  selector: 'app-queued-messages',
  imports: [AppIcon],
  template: `
    <div class="header">
      <button
        type="button"
        class="summary"
        [attr.aria-expanded]="expanded()"
        aria-controls="queued-list"
        (click)="expanded.set(!expanded())"
        data-testid="queued-toggle"
      >
        <span class="count">{{ messages().length }} queued</span>
        <span class="hint">· sent when the turn ends</span>
        <app-icon [name]="expanded() ? 'chevron-down' : 'chevron-right'" />
      </button>
      <button
        type="button"
        class="send-all"
        (click)="sendNow.emit(null)"
        [disabled]="!enabled()"
        title="Stop the turn and send the queued messages now"
        data-testid="send-queued"
      >
        Send now
      </button>
    </div>
    <ul
      id="queued-list"
      class="queued"
      [hidden]="!expanded()"
      data-testid="queued"
    >
      @for (item of messages(); track item.key) {
        <li class="queued-message" data-testid="queued-message">
          <span class="queued-text" [title]="item.text">{{
            item.attachments.length > 0
              ? (item.attachments.length === 1
                  ? '[1 image] '
                  : '[' + item.attachments.length + ' images] ') + item.text
              : item.text
          }}</span>
          <button
            type="button"
            class="app-icon-btn"
            (click)="sendNow.emit(item.id)"
            [disabled]="!enabled()"
            title="Stop the turn and send this message now"
            data-testid="send-queued-message"
          >
            <app-icon name="send" /><span class="visually-hidden"
              >Send now</span
            >
          </button>
          <button
            type="button"
            class="app-icon-btn"
            (click)="remove.emit(item.id)"
            [disabled]="!enabled()"
            title="Remove from the queue"
            data-testid="unqueue"
          >
            <app-icon name="close" /><span class="visually-hidden">Remove</span>
          </button>
        </li>
      }
    </ul>
  `,
  styleUrl: './queued-messages.scss',
})
export class QueuedMessages {
  readonly messages =
    input.required<Extract<ConversationItem, { kind: 'queued' }>[]>();
  readonly enabled = input(true);
  /** ID of the message to remove. */
  readonly remove = output<string>();
  /** ID of the message to send right away, `null` for all of them. */
  readonly sendNow = output<string | null>();
  protected readonly expanded = signal(false);
}
