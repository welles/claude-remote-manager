import { TextFieldModule } from '@angular/cdk/text-field';
import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, of, Subject, switchMap } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  ATTACHMENT_MEDIA_TYPES,
  type AttachmentDto,
  type FileMention,
  type MessageReference,
  type MessageReferenceRequest,
} from '@claude-remote-manager/shared-types';
import { ReferenceAutocomplete } from '../github-references/reference-autocomplete';
import { ReferenceChips } from '../github-references/reference-chips';
import { ReferenceSuggestions } from '../github-references/reference-suggestions';
import {
  draftReferences,
  optionsOf,
  type ReferenceOptions,
} from '../github-references/references';
import { AttachmentDrafts, imageFiles } from '../attachments/attachment-drafts';
import { AttachmentsApi } from '../attachments/attachments-api';
import { DraftImages } from '../attachments/draft-images';
import { SessionsApi } from './sessions-api';

/** The `@` reference being typed before the caret: `@` then no spaces. */
const MENTION = /(?:^|\s)@([^\s"@]*)$/;

/** A message the user wants to send. */
export interface ComposedMessage {
  /** ID to reuse (a message that was not sent before), else `null`. */
  id: string | null;
  text: string;
  attachmentIds: string[];
  /** GitHub issues and pull requests referenced in the text. */
  references: MessageReferenceRequest[];
}

/**
 * The input of the session view: text, images (paste, drop or pick; each
 * uploaded right away and removable), `@` references to files of the
 * session (autocomplete over all its directories), `#` references to
 * GitHub issues and pull requests (autocomplete, chips with the choice to
 * give Claude comments and diffs) and the Send and Stop buttons.
 */
@Component({
  selector: 'app-message-composer',
  imports: [
    DraftImages,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    ReferenceChips,
    ReferenceSuggestions,
    TextFieldModule,
  ],
  templateUrl: './message-composer.html',
  styleUrl: './message-composer.scss',
})
export class MessageComposer {
  /** Text in the input box (bound to the textarea's value). */
  readonly draft = model('');
  readonly label = input('Message');
  /** Sending is not possible right now (not connected, preparing, ...). */
  readonly disabled = input(false);
  /** A turn runs: Stop is offered. */
  readonly running = input(false);
  /** Session whose files `@` offers; without, no autocomplete. */
  readonly sessionId = input<string | null>(null);
  /** Name the repository of files (sessions with several directories). */
  readonly showRepository = input(false);
  /**
   * GitHub repositories of the session, the main one first: `#` searches
   * them, `#12` refers to the first. Without, `#` offers nothing.
   */
  readonly githubRepositories = input<string[]>([]);
  readonly send = output<ComposedMessage>();
  readonly interrupt = output<void>();

  private readonly api = inject(SessionsApi);
  private readonly textarea =
    viewChild<ElementRef<HTMLTextAreaElement>>('textarea');
  /** Where the `@` reference being typed starts, and its text. */
  protected readonly mention = signal<{ start: number; query: string } | null>(
    null,
  );
  protected readonly suggestions = signal<FileMention[]>([]);
  protected readonly active = signal(0);
  protected readonly suggesting = computed(
    () => this.mention() !== null && this.suggestions().length > 0,
  );
  private readonly queries = new Subject<string>();
  /** `#` autocomplete. */
  protected readonly references = new ReferenceAutocomplete(
    () => this.githubRepositories(),
    (value) => this.draft.set(value),
  );
  /** Comments and diffs chosen per reference (`owner/repo#12` key). */
  protected readonly referenceOptions = signal<
    ReadonlyMap<string, ReferenceOptions>
  >(new Map());

  constructor() {
    this.queries
      .pipe(
        debounceTime(120),
        switchMap((query) => {
          const id = this.sessionId();
          return id
            ? this.api
                .files(id, query)
                .pipe(catchError(() => of({ files: [], truncated: false })))
            : of({ files: [], truncated: false });
        }),
        takeUntilDestroyed(),
      )
      .subscribe((result) => {
        this.suggestions.set(result.files);
        this.active.set(0);
      });
  }

  protected readonly images = new AttachmentDrafts(inject(AttachmentsApi));
  protected readonly accept = ATTACHMENT_MEDIA_TYPES.join(',');
  protected readonly canSend = computed(
    () =>
      !this.disabled() &&
      !this.images.busy() &&
      (this.draft().trim() !== '' || this.images.ids().length > 0),
  );
  /** ID of a message being sent again. */
  private reuseId: string | null = null;

  /** Puts a message that was not sent back into the input. */
  restore(
    id: string,
    text: string,
    attachments: AttachmentDto[],
    references: readonly MessageReference[] = [],
  ): void {
    this.draft.set(this.draft().trim() ? `${this.draft()}\n\n${text}` : text);
    this.referenceOptions.update(
      (options) => new Map([...options, ...optionsOf(references)]),
    );
    if (attachments.length > 0) {
      // The images belong to that message: send it under its ID again.
      this.reuseId = id;
      this.images.restore(attachments);
    }
  }

  /** Empties the input after the message went out. */
  clear(): void {
    this.draft.set('');
    this.images.clear();
    this.reuseId = null;
    this.referenceOptions.set(new Map());
  }

  protected setReferenceOptions(change: {
    key: string;
    options: ReferenceOptions;
  }): void {
    this.referenceOptions.update((options) =>
      new Map(options).set(change.key, change.options),
    );
  }

  protected submit(): void {
    if (!this.canSend()) {
      return;
    }
    this.send.emit({
      id: this.reuseId,
      text: this.draft().trim(),
      attachmentIds: this.images.ids(),
      references: draftReferences(
        this.draft().trim(),
        this.githubRepositories(),
        this.referenceOptions(),
      ),
    });
  }

  protected onInput(event: Event): void {
    const field = event.target as HTMLTextAreaElement;
    this.draft.set(field.value);
    this.findMention(field);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
      return;
    }
    if (this.references.keydown(event, event.target as HTMLTextAreaElement)) {
      return;
    }
    if (!this.suggesting()) {
      return;
    }
    const count = this.suggestions().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => (index + 1) % count);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => (index - 1 + count) % count);
        return;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        this.choose(this.suggestions()[this.active()]);
        return;
      case 'Escape':
        event.preventDefault();
        this.closeMention();
        return;
    }
  }

  /** Caret moved (click, arrow keys): the `@` reference may have changed. */
  protected onCaret(event: Event): void {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(key)) {
      this.findMention(event.target as HTMLTextAreaElement);
    }
  }

  /** Replaces the `@` reference being typed with the chosen file. */
  protected choose(file: FileMention): void {
    const mention = this.mention();
    const field = this.textarea()?.nativeElement;
    if (!mention || !field) {
      return;
    }
    const value = this.draft();
    const end = mention.start + 1 + mention.query.length;
    const inserted = `${file.mention} `;
    const next = value.slice(0, mention.start) + inserted + value.slice(end);
    field.value = next;
    this.draft.set(next);
    const caret = mention.start + inserted.length;
    field.setSelectionRange(caret, caret);
    field.focus();
    this.closeMention();
  }

  protected closeMention(): void {
    this.mention.set(null);
    this.suggestions.set([]);
  }

  protected closeSuggestions(): void {
    this.closeMention();
    this.references.close();
  }

  private findMention(field: HTMLTextAreaElement): void {
    if (this.references.update(field)) {
      this.closeMention();
      return;
    }
    if (!this.sessionId() || field.selectionStart !== field.selectionEnd) {
      this.closeMention();
      return;
    }
    const before = field.value.slice(0, field.selectionStart);
    const match = MENTION.exec(before);
    if (!match) {
      this.closeMention();
      return;
    }
    const query = match[1];
    const start = field.selectionStart - query.length - 1;
    const current = this.mention();
    if (current?.start === start && current.query === query) {
      return;
    }
    this.mention.set({ start, query });
    this.queries.next(query);
  }

  protected onPaste(event: ClipboardEvent): void {
    const files = imageFiles(event.clipboardData?.items ?? null);
    if (files.length > 0) {
      event.preventDefault();
      this.images.add(files);
    }
  }

  protected onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
    }
  }

  protected onDrop(event: DragEvent): void {
    const files = imageFiles(event.dataTransfer?.files ?? null);
    if (files.length > 0) {
      event.preventDefault();
      this.images.add(files);
    }
  }

  protected onPick(event: Event): void {
    const field = event.target as HTMLInputElement;
    this.images.add(imageFiles(field.files));
    field.value = '';
  }
}
