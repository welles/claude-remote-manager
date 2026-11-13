import { Component, inject, input, signal } from '@angular/core';
import { errorMessage } from '../repositories/repositories-api';
import { ReferencesApi } from './references-api';

/**
 * Below a sent message: the GitHub content the app gave Claude with it,
 * exactly as Claude got it, loaded when opened.
 */
@Component({
  selector: 'app-message-context',
  template: `
    <details (toggle)="toggled($event)" data-testid="message-context">
      <summary>GitHub context for Claude ({{ size() }})</summary>
      @if (error(); as message) {
        <p class="error">{{ message }}</p>
      } @else if (text() === null) {
        <p>Loading…</p>
      } @else {
        <pre>{{ text() }}</pre>
      }
    </details>
  `,
  styles: `
    :host {
      display: block;
      align-self: flex-end;
      max-width: 85%;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    summary {
      cursor: pointer;
      text-align: end;
    }
    pre {
      max-height: 50vh;
      overflow: auto;
      padding: 8px;
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class MessageContext {
  readonly sessionId = input.required<string>();
  readonly messageId = input.required<string>();
  /** Characters of the context. */
  readonly length = input.required<number>();

  private readonly api = inject(ReferencesApi);
  protected readonly text = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected size(): string {
    const length = this.length();
    return length < 1000
      ? `${length} characters`
      : `${(length / 1000).toFixed(1)}k characters`;
  }

  protected toggled(event: Event): void {
    if (!(event.target as HTMLDetailsElement).open || this.text() !== null) {
      return;
    }
    this.error.set(null);
    this.api.messageContext(this.sessionId(), this.messageId()).subscribe({
      next: (response) => this.text.set(response.context),
      error: (error: unknown) =>
        this.error.set(errorMessage(error, 'The context could not be loaded.')),
    });
  }
}
