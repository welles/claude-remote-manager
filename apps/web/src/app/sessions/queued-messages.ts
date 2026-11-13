import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { ConversationItem } from './conversation';

/** Messages waiting for the running turn to end; each can be removed. */
@Component({
  selector: 'app-queued-messages',
  imports: [MatButtonModule],
  template: `
    <ul class="queued" data-testid="queued">
      @for (item of messages(); track item.key) {
        <li class="queued-message" data-testid="queued-message">
          <span class="queued-label">Queued</span>
          <span class="queued-text" [title]="item.text">{{ item.text }}</span>
          <button
            matButton
            (click)="remove.emit(item.id)"
            [disabled]="!enabled()"
            data-testid="unqueue"
          >
            Remove
          </button>
        </li>
      }
    </ul>
    <p class="hint">Sent to Claude when the current turn ends.</p>
  `,
  styleUrl: './queued-messages.scss',
})
export class QueuedMessages {
  readonly messages =
    input.required<Extract<ConversationItem, { kind: 'queued' }>[]>();
  readonly enabled = input(true);
  /** ID of the message to remove. */
  readonly remove = output<string>();
}
