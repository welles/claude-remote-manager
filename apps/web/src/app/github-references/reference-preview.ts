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
 * resources), the link to GitHub, what was included, and in the input the
 * choice to give Claude the comments and the diff. Loaded on first use.
 */
@Component({
  selector: 'app-reference-preview',
  imports: [MarkdownPipe],
  template: `
    <p class="mt-0 mb-1.5 type-body-small text-on-surface-variant">
      <span class="badge tone-{{ state() }}">{{ state() }}</span>
      {{ kindLabel() }} {{ chip().repository }}#{{ chip().number }}
    </p>
    @if (chip().title) {
      <p class="mt-0 mb-1.5 type-title-small">{{ chip().title }}</p>
    }
    @if (chip().error; as error) {
      <p class="mt-0 mb-1.5 text-error" data-testid="reference-error">
        {{ error }}
      </p>
    }
    @if (detail(); as detail) {
      <p class="mt-0 mb-1.5 type-body-small text-on-surface-variant">
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
          class="markdown mb-1.5 max-h-[30vh] overflow-auto type-body-small"
          [innerHTML]="
            detail.body + (detail.bodyTruncated ? '\\n\\n…' : '') | markdown
          "
        ></div>
      } @else {
        <p class="mt-0 mb-1.5 type-body-small text-on-surface-variant">
          No description.
        </p>
      }
    } @else if (loading()) {
      <p class="mt-0 mb-1.5 type-body-small text-on-surface-variant">
        Loading…
      </p>
    }
    @if (editable()) {
      @if (chip().status !== 'failed') {
        <label class="flex min-h-8 items-center gap-1.5">
          <input
            type="checkbox"
            [checked]="chip().comments"
            (change)="set('comments', $event)"
            data-testid="reference-comments"
          />
          Include the comments
        </label>
        @if (chip().kind === 'pull_request') {
          <label class="flex min-h-8 items-center gap-1.5">
            <input
              type="checkbox"
              [checked]="chip().diff"
              (change)="set('diff', $event)"
              data-testid="reference-diff"
            />
            Include the diff
          </label>
        }
      }
    } @else if (chip().status === 'resolved') {
      <p
        class="mt-0 mb-1.5 type-body-small text-on-surface-variant"
        data-testid="reference-included"
      >
        Included: {{ included() }}
      </p>
      @for (note of chip().notes; track note) {
        <p class="mt-0 mb-1.5 type-body-small text-secondary">{{ note }}</p>
      }
    }
    <a
      class="mt-1 inline-block py-1"
      [href]="chip().url"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="reference-link"
      >Open on GitHub ↗</a
    >
  `,
  host: {
    class:
      'block max-h-[60vh] w-[min(360px,calc(100vw-32px))] overflow-auto rounded-sm bg-surface-container-high p-3 whitespace-normal text-on-surface shadow-2',
    role: 'dialog',
  },
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
