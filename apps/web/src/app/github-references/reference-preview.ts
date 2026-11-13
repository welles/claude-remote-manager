import { Component, computed, inject, input, output } from '@angular/core';
import { MarkdownPipe } from '../sessions/markdown.pipe';
import {
  ReferenceDetails,
  stateLabel,
  type ReferenceChipModel,
  type ReferenceOptions,
} from './references';

/**
 * The preview of a reference chip: kind, state, title, author, labels and
 * the start of the description (GitHub Markdown, rendered without remote
 * resources), the link to GitHub, what Claude got, and in the input the
 * choice to give Claude the comments and the diff. Loaded on first use.
 */
@Component({
  selector: 'app-reference-preview',
  imports: [MarkdownPipe],
  template: `
    <p class="meta">
      <span class="badge state-{{ state() }}">{{ state() }}</span>
      {{ kindLabel() }} {{ chip().repository }}#{{ chip().number }}
    </p>
    @if (chip().title) {
      <p class="title">{{ chip().title }}</p>
    }
    @if (chip().error; as error) {
      <p class="error" data-testid="reference-error">{{ error }}</p>
    }
    @if (detail(); as detail) {
      <p class="facts">
        @if (detail.author) {
          by &#64;{{ detail.author }}
        }
        @if (detail.labels.length > 0) {
          · {{ detail.labels.join(', ') }}
        }
        @if (detail.pull; as pull) {
          · {{ pull.headBranch }} → {{ pull.baseBranch }}, +{{
            pull.additions
          }}
          −{{ pull.deletions }} in {{ pull.changedFiles }} files
        }
      </p>
      @if (detail.body.trim()) {
        <div
          class="body markdown"
          [innerHTML]="
            detail.body + (detail.bodyTruncated ? '\\n\\n…' : '') | markdown
          "
        ></div>
      } @else {
        <p class="facts">No description.</p>
      }
    } @else if (loading()) {
      <p class="facts">Loading…</p>
    }
    @if (editable()) {
      @if (chip().status !== 'failed') {
        <label class="option">
          <input
            type="checkbox"
            [checked]="chip().comments"
            (change)="set('comments', $event)"
            data-testid="reference-comments"
          />
          Give Claude the comments
        </label>
        @if (chip().kind === 'pull_request') {
          <label class="option">
            <input
              type="checkbox"
              [checked]="chip().diff"
              (change)="set('diff', $event)"
              data-testid="reference-diff"
            />
            Give Claude the diff
          </label>
        }
      }
    } @else if (chip().status === 'resolved') {
      <p class="facts" data-testid="reference-included">
        Claude got: {{ included() }}
      </p>
      @for (note of chip().notes; track note) {
        <p class="note">{{ note }}</p>
      }
    }
    <a
      class="link"
      [href]="chip().url"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="reference-link"
      >Open on GitHub ↗</a
    >
  `,
  host: { role: 'dialog' },
  styles: `
    :host {
      display: block;
      width: min(360px, calc(100vw - 32px));
      max-height: 60vh;
      overflow: auto;
      padding: 12px;
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      box-shadow: var(--mat-sys-level2);
      white-space: normal;
    }
    p {
      margin: 0 0 6px;
    }
    .meta,
    .facts,
    .note {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .note {
      color: var(--mat-sys-secondary);
    }
    .title {
      font: var(--mat-sys-title-small);
    }
    .badge {
      padding: 0 6px;
      border-radius: var(--mat-sys-corner-extra-small);
      color: var(--app-gh-on-state);
      background: var(--app-gh-draft);
    }
    .state-open {
      background: var(--app-gh-open);
    }
    .state-merged {
      background: var(--app-gh-merged);
    }
    .state-closed {
      background: var(--app-gh-closed);
    }
    .state-draft {
      background: var(--app-gh-draft);
    }
    .error {
      color: var(--mat-sys-error);
    }
    .body {
      max-height: 30vh;
      overflow: auto;
      overflow-wrap: anywhere;
      margin-bottom: 6px;
      font: var(--mat-sys-body-small);
    }
    .option {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
    }
    .link {
      display: inline-block;
      margin-top: 4px;
      padding: 4px 0;
    }
  `,
})
export class ReferencePreview {
  readonly chip = input.required<ReferenceChipModel>();
  readonly editable = input(false);
  readonly optionsChange = output<ReferenceOptions>();

  private readonly details = inject(ReferenceDetails);
  private readonly loaded = computed(() => {
    const chip = this.chip();
    return chip.status === 'failed'
      ? null
      : this.details.get(chip.repository, chip.number);
  });
  protected readonly detail = computed(() => {
    const state = this.loaded()?.();
    return state?.status === 'resolved' ? state.detail : null;
  });
  protected readonly loading = computed(
    () => this.loaded()?.().status === 'loading',
  );
  protected readonly state = computed(() => stateLabel(this.chip()));
  protected readonly kindLabel = computed(() =>
    this.chip().kind === 'pull_request'
      ? 'Pull request'
      : this.chip().kind === 'issue'
        ? 'Issue'
        : '',
  );
  protected readonly included = computed(() => {
    const chip = this.chip();
    const failed = (start: string) =>
      chip.notes.some((note) => note.startsWith(start));
    return [
      'title and description',
      ...(chip.comments && !failed('Comments could not') ? ['comments'] : []),
      ...(chip.diff &&
      chip.kind === 'pull_request' &&
      !failed('The diff could not')
        ? ['diff']
        : []),
    ].join(', ');
  });

  protected set(option: 'comments' | 'diff', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const chip = this.chip();
    this.optionsChange.emit({
      comments: chip.comments,
      diff: chip.diff,
      [option]: checked,
    });
  }
}
