import { Component, inject, input, signal } from '@angular/core';
import { errorMessage } from '../repositories/repositories-api';
import { ReferencesApi } from './references-api';

/**
 * Below a sent message: the GitHub content the app gave Claude with it,
 * exactly as Claude got it, loaded when opened.
 */
@Component({
  selector: 'app-message-context',
  host: {
    class: 'block max-w-[85%] self-end type-body-small text-on-surface-variant',
  },
  template: `
    <details (toggle)="toggled($event)" data-testid="message-context">
      <summary class="cursor-pointer text-end">
        GitHub context for Claude ({{ size() }})
      </summary>
      @if (error(); as message) {
        <p class="text-error">{{ message }}</p>
      } @else if (text() === null) {
        <p>Loading…</p>
      } @else {
        <pre
          class="max-h-[50vh] overflow-auto rounded-sm bg-surface-container p-2 whitespace-pre-wrap wrap-anywhere"
          >{{ text() }}</pre
        >
      }
    </details>
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
