import { Component, computed, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { AppIcon } from '../ui/icon';
import type { ConversationItem } from './conversation';

/**
 * Messages waiting for the running turn to end (or for the usage limit to
 * reset), collapsed to one line
 * ("2 queued · sent when the turn ends") that expands to the list, where
 * each can be removed. "Send now" (all, or one in the list) stops the turn
 * and sends them right away; until the stopped turn ends, they show as
 * being sent.
 */
@Component({
  selector: 'app-queued-messages',
  imports: [AppIcon, MatButtonModule],
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
        <span class="hint" data-testid="queued-hint">{{
          anySending()
            ? '· sending now…'
            : heldForLimit()
              ? '· sent when the usage limit resets'
              : '· sent when the turn ends'
        }}</span>
        <app-icon [name]="expanded() ? 'chevron-down' : 'chevron-right'" />
      </button>
      <button
        matButton
        type="button"
        class="flex-none"
        (click)="sendNow.emit(null)"
        [disabled]="!enabled() || allSending()"
        [title]="
          heldForLimit()
            ? 'Send the queued messages now, before the usage limit resets'
            : 'Stop the turn and send the queued messages now'
        "
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
            class="icon-btn"
            (click)="sendNow.emit(item.id)"
            [disabled]="!enabled() || sending().has(item.id)"
            [title]="
              heldForLimit()
                ? 'Send this message now, before the usage limit resets'
                : 'Stop the turn and send this message now'
            "
            [attr.aria-label]="'Send now: ' + item.text"
            data-testid="send-queued-message"
          >
            <app-icon name="send" />
          </button>
          <button
            type="button"
            class="icon-btn"
            (click)="remove.emit(item.id)"
            [disabled]="!enabled()"
            title="Remove from the queue"
            [attr.aria-label]="'Remove: ' + item.text"
            data-testid="unqueue"
          >
            <app-icon name="close" />
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
  /** Held until the usage limit resets (no turn runs). */
  readonly heldForLimit = input(false);
  /** IDs of the messages being sent right away. */
  readonly sending = input<ReadonlySet<string>>(new Set());
  /** ID of the message to remove. */
  readonly remove = output<string>();
  /** ID of the message to send right away, `null` for all of them. */
  readonly sendNow = output<string | null>();
  protected readonly expanded = signal(false);
  /** Some queued message is being sent right away. */
  protected readonly anySending = computed(() =>
    this.messages().some((item) => this.sending().has(item.id)),
  );
  /** Every queued message is being sent right away. */
  protected readonly allSending = computed(() =>
    this.messages().every((item) => this.sending().has(item.id)),
  );
}
