import {
  Component,
  afterRenderEffect,
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
import {
  ATTACHMENT_MEDIA_TYPES,
  type AttachmentDto,
  type FileMention,
  type MessageReference,
  type MessageReferenceRequest,
  type SlashCommandOption,
} from '@claude-remote-manager/shared-types';
import { AppIcon } from '../ui/icon';
import { ReferenceAutocomplete } from '../github-references/reference-autocomplete';
import { ReferenceChips } from '../github-references/reference-chips';
import { ReferenceSuggestions } from '../github-references/reference-suggestions';
import { DraftReferences } from '../github-references/draft-references';
import {
  optionsOf,
  qualifyReference,
  type ReferenceOptions,
} from '../github-references/references';
import { AttachmentDrafts, imageFiles } from '../attachments/attachment-drafts';
import { AttachmentsApi } from '../attachments/attachments-api';
import { DraftImages } from '../attachments/draft-images';
import { SessionsApi } from './sessions-api';

/** The `@` reference being typed before the caret: `@` then no spaces. */
const MENTION = /(?:^|\s)@([^\s"@]*)$/;

/** A slash command being typed: the message starts with `/`, no space yet. */
const SLASH = /^\/(\S*)$/;

/** At most this many commands are listed. */
const MAX_COMMANDS = 100;

/**
 * Commands matching what was typed after `/`: names and aliases starting
 * with it first, then names containing it.
 */
export function matchCommands(
  commands: readonly SlashCommandOption[],
  query: string,
): SlashCommandOption[] {
  const typed = query.toLowerCase();
  const starts = commands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(typed) ||
      command.aliases.some((alias) => alias.toLowerCase().startsWith(typed)),
  );
  const contains = commands.filter(
    (command) =>
      !starts.includes(command) && command.name.toLowerCase().includes(typed),
  );
  return [...starts, ...contains].slice(0, MAX_COMMANDS);
}

/** Eight lines of the composer's text plus its padding. */
const MAX_INPUT_HEIGHT = 8 * 22 + 20;

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
 * give Claude comments and diffs), `/` for Claude Code's slash commands and
 * skills at the start of a message (autocomplete), Claude Code's suggested
 * next message as placeholder and the Send and Stop buttons.
 */
@Component({
  selector: 'app-message-composer',
  imports: [AppIcon, DraftImages, ReferenceChips, ReferenceSuggestions],
  templateUrl: './message-composer.html',
})
export class MessageComposer {
  /** Text in the input box (bound to the textarea's value). */
  readonly draft = model('');
  readonly label = input('Message');
  /** Sending is not possible right now (not connected, preparing, ...). */
  readonly disabled = input(false);
  /** A turn runs: Stop is offered. */
  readonly running = input(false);
  /**
   * Claude Code's guess at the next message, as in the terminal: the
   * placeholder of the empty input; Tab (or the edit button) puts it into
   * the input, Send sends it as it is (if it is wholly visible).
   */
  readonly suggestion = input<string | null>(null);
  /** Session whose files `@` offers; without, no autocomplete. */
  readonly sessionId = input<string | null>(null);
  /** Name the repository of files (sessions with several directories). */
  readonly showRepository = input(false);
  /**
   * GitHub repositories of the session, the main one first: `#` searches
   * them; `#12` refers to the one that has it (or the first, see
   * DraftReferences). Without, `#` offers nothing.
   */
  readonly githubRepositories = input<string[]>([]);
  readonly send = output<ComposedMessage>();
  readonly interrupt = output<void>();

  private readonly api = inject(SessionsApi);
  private readonly textarea =
    viewChild<ElementRef<HTMLTextAreaElement>>('textarea');
  /** Hidden copy of the input that measures the suggestion. */
  private readonly mirror =
    viewChild<ElementRef<HTMLTextAreaElement>>('mirror');
  /**
   * The whole suggestion fits into the input (at most 8 lines): only then
   * does Send send it, so that nothing unseen goes out.
   */
  protected readonly suggestionFits = signal(true);
  /**
   * Grows the textarea with its text, up to 8 lines (then it scrolls); also
   * when the draft changes from outside (sent, restored). An empty input
   * showing the suggestion grows to fit it, measured in the hidden mirror
   * (writing the field's value would clear its undo history).
   */
  private readonly autosize = afterRenderEffect(() => {
    this.draft();
    const suggestion = this.offering() ? this.suggestion() : null;
    const field = this.textarea()?.nativeElement;
    const mirror = this.mirror()?.nativeElement;
    if (!field) {
      return;
    }
    field.style.height = 'auto';
    let height = field.scrollHeight;
    if (suggestion && field.value === '' && mirror) {
      mirror.style.width = `${field.clientWidth}px`;
      mirror.value = suggestion;
      mirror.style.height = 'auto';
      height = Math.max(height, mirror.scrollHeight);
      this.suggestionFits.set(mirror.scrollHeight <= MAX_INPUT_HEIGHT);
    }
    field.style.height = `${Math.min(height, MAX_INPUT_HEIGHT)}px`;
  });
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
  /** What was typed after a leading `/`, while choosing a command. */
  protected readonly slash = signal<string | null>(null);
  /** The session's commands, loaded when `/` is typed. */
  private readonly commands = signal<readonly SlashCommandOption[]>([]);
  private commandsOf: string | null = null;
  /** Answers to older requests are dropped. */
  private commandRequest = 0;
  protected readonly commandMatches = computed(() => {
    const query = this.slash();
    return query === null ? [] : matchCommands(this.commands(), query);
  });
  protected readonly suggestingCommands = computed(
    () => this.commandMatches().length > 0,
  );
  /** The option screen readers announce as chosen. */
  protected readonly activeCommandId = computed(() =>
    this.suggestingCommands()
      ? `command-${Math.min(this.active(), this.commandMatches().length - 1)}`
      : null,
  );
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
      !this.draftReferences.unresolved() &&
      (this.draft().trim() !== '' ||
        this.images.ids().length > 0 ||
        this.sendsSuggestion()),
  );
  /** The suggestion is offered: there is one and nothing was typed. */
  protected readonly offering = computed(
    () =>
      !!this.suggestion() &&
      !this.disabled() &&
      this.draft() === '' &&
      this.images.images().length === 0,
  );
  /** Send sends the suggestion: offered and wholly visible. */
  private readonly sendsSuggestion = computed(
    () => this.offering() && this.suggestionFits(),
  );
  /** Text whose `#` references the chips show (the suggestion when offered). */
  protected readonly referenceText = computed(() =>
    this.offering() ? (this.suggestion() ?? '') : this.draft(),
  );
  /** The references of {@link referenceText}, for the chips and sending. */
  protected readonly draftReferences = new DraftReferences(
    () => this.referenceText(),
    () => this.githubRepositories(),
    () => this.referenceOptions(),
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
    // With several repositories, the restored #12 keeps the repository it
    // was sent with instead of being looked up again.
    const qualified =
      this.githubRepositories().length > 1
        ? references
            .filter((reference) => reference.token.startsWith('#'))
            .reduce(
              (current, reference) =>
                qualifyReference(
                  current,
                  reference.number,
                  reference.repository,
                ).text,
              text,
            )
        : text;
    this.draft.set(
      this.draft().trim() ? `${this.draft()}\n\n${qualified}` : qualified,
    );
    this.referenceOptions.update(
      (options) => new Map([...options, ...optionsOf(references)]),
    );
    if (attachments.length > 0) {
      // The images belong to that message: send it under its ID again.
      this.reuseId = id;
      this.images.restore(attachments);
    }
  }

  /** Whether text or images wait in the input. */
  hasContent(): boolean {
    return this.draft().trim() !== '' || this.images.images().length > 0;
  }

  /** Puts the caret into the input. */
  focus(): void {
    this.textarea()?.nativeElement.focus();
  }

  /** Empties the input after the message went out. */
  clear(): void {
    this.draft.set('');
    this.images.clear();
    this.reuseId = null;
    this.referenceOptions.set(new Map());
  }

  /** Puts the suggestion into the input, the caret at its end. */
  protected takeSuggestion(): void {
    const text = this.suggestion();
    const field = this.textarea()?.nativeElement;
    if (!text || !this.offering()) {
      return;
    }
    this.draft.set(text);
    if (field) {
      field.value = text;
      field.focus();
      field.setSelectionRange(text.length, text.length);
    }
  }

  protected setReferenceOptions(change: {
    key: string;
    options: ReferenceOptions;
  }): void {
    this.referenceOptions.update((options) =>
      new Map(options).set(change.key, change.options),
    );
  }

  /** The user chose which repository a `#12` means. */
  protected chooseReferenceRepository(choice: {
    number: number;
    repository: string;
  }): void {
    const field = this.textarea()?.nativeElement;
    const text = this.referenceText();
    const next = qualifyReference(
      text,
      choice.number,
      choice.repository,
      this.offering() || !field ? text.length : field.selectionStart,
    );
    this.draft.set(next.text);
    if (field) {
      // The tap blurred the input: give it the caret back.
      field.value = next.text;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    }
  }

  protected submit(): void {
    if (!this.canSend()) {
      return;
    }
    // An empty input sends the suggestion it shows.
    const text = this.sendsSuggestion()
      ? (this.suggestion() ?? '').trim()
      : this.draft().trim();
    this.send.emit({
      id: this.reuseId,
      text,
      attachmentIds: this.images.ids(),
      references: this.draftReferences.requests(text),
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
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      this.offering()
    ) {
      event.preventDefault();
      this.takeSuggestion();
      return;
    }
    if (this.suggestingCommands()) {
      const count = this.commandMatches().length;
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
          this.chooseCommand(
            this.commandMatches()[Math.min(this.active(), count - 1)],
          );
          return;
        case 'Escape':
          event.preventDefault();
          this.slash.set(null);
          return;
      }
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
    this.slash.set(null);
  }

  /** Replaces the command being typed with the chosen one. */
  protected chooseCommand(command: SlashCommandOption | undefined): void {
    const field = this.textarea()?.nativeElement;
    if (!command || this.slash() === null || !field) {
      return;
    }
    const value = this.draft();
    const typed = SLASH.exec(value.slice(0, field.selectionStart))?.[0] ?? '/';
    const inserted = `/${command.name} `;
    // The rest of the word typed into; a space after it (not a line break).
    const next = inserted + value.slice(typed.length).replace(/^\S*[ \t]?/, '');
    field.value = next;
    this.draft.set(next);
    field.setSelectionRange(inserted.length, inserted.length);
    field.focus();
    this.slash.set(null);
  }

  /** A message starting with `/` and no space before the caret: commands. */
  private findCommand(field: HTMLTextAreaElement): boolean {
    const id = this.sessionId();
    const match =
      id && field.selectionStart === field.selectionEnd
        ? SLASH.exec(field.value.slice(0, field.selectionStart))
        : null;
    if (!id || !match) {
      this.slash.set(null);
      return false;
    }
    if (this.slash() === null) {
      this.active.set(0);
      this.loadCommands(id);
    } else if (this.slash() !== match[1]) {
      this.active.set(0);
    }
    this.slash.set(match[1]);
    return true;
  }

  /** Asks for the session's commands each time `/` opens the list. */
  private loadCommands(id: string): void {
    if (this.commandsOf !== id) {
      this.commands.set([]);
      this.commandsOf = id;
    }
    const request = ++this.commandRequest;
    this.api
      .slashCommands(id)
      .pipe(catchError(() => of({ commands: [], source: 'user' as const })))
      .subscribe((result) => {
        if (this.commandsOf === id && request === this.commandRequest) {
          this.commands.set(result.commands);
          this.active.set(0);
        }
      });
  }

  private findMention(field: HTMLTextAreaElement): void {
    if (this.findCommand(field)) {
      this.closeMention();
      this.references.close();
      return;
    }
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
