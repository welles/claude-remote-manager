import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  toggleComment,
} from '@codemirror/commands';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  keymap,
  placeholder as placeholderText,
} from '@codemirror/view';
import { MatFormFieldControl } from '@angular/material/form-field';
import { Subject } from 'rxjs';
import { formatCommand, type MarkdownFormat } from './markdown-commands';
import { markdownEditing } from './markdown-extensions';
import type { TextField } from './text-field';

/**
 * The editor's look in the app's tokens (CodeMirror builds its DOM itself,
 * so no utilities). The page sizes it through `--app-editor-max-height`,
 * `--app-editor-padding` and `--app-editor-font`.
 */
const editorTheme = EditorView.theme({
  '&': {
    maxHeight: 'var(--app-editor-max-height, none)',
    color: 'var(--mat-sys-on-surface)',
    font: 'var(--app-editor-font, var(--mat-sys-body-large))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflowY: 'auto',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
  },
  '.cm-content': {
    padding: 'var(--app-editor-padding, 0)',
    caretColor: 'var(--mat-sys-on-surface)',
  },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--mat-sys-on-surface-variant)' },
  // Claude Code's suggested next message, as in the terminal.
  '[data-suggestion] .cm-placeholder': { fontStyle: 'italic' },
  '.cm-md-mark': {
    color: 'var(--mat-sys-on-surface-variant)',
    fontWeight: '400',
  },
  '.cm-md-code': { fontFamily: 'var(--app-font-mono)', fontSize: '0.875em' },
  '.cm-md-link': { color: 'var(--mat-sys-primary)' },
  '.cm-md-url': {
    color: 'var(--mat-sys-on-surface-variant)',
    textDecoration: 'underline',
  },
  '.cm-md-code-block': {
    background: 'var(--mat-sys-surface-container-high)',
    fontFamily: 'var(--app-font-mono)',
    fontSize: '0.875em',
  },
  '.cm-line.cm-md-quote': {
    paddingLeft: 'var(--app-space-2)',
    borderLeft: '3px solid var(--mat-sys-outline-variant)',
  },
  '.cm-md-quote-text': { color: 'var(--mat-sys-on-surface-variant)' },
});

/** Changes made by the page, not typed: no `edited` event. */
const programmatic = Annotation.define<boolean>();

let nextId = 0;

/**
 * A Markdown editor (CodeMirror) in place of a textarea: the Markdown
 * stays as typed but is styled live (headings, bold, lists, code, quotes),
 * with shortcuts and {@link format} for a toolbar. `value` is the text;
 * the outputs follow the textarea's events (`edited` for input, `caret`
 * for a moved selection without an edit). Implements {@link TextField} for
 * the autocompletes, and Material's form field control (label, outline,
 * hint) for use inside `mat-form-field`.
 */
@Component({
  selector: 'app-markdown-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  providers: [{ provide: MatFormFieldControl, useExisting: MarkdownEditor }],
  host: { '[id]': 'id', class: 'block min-w-0' },
})
export class MarkdownEditor implements TextField, MatFormFieldControl<string> {
  /** The text; changes from outside replace it (and its undo history). */
  readonly text = model('');
  /** Shown while empty (`placeholder` is the form field's). */
  readonly hint = input('');
  /** The placeholder is a suggestion (shown in italics). */
  readonly suggestion = input(false);
  /**
   * Attributes of the editable element (ARIA for comboboxes, test IDs);
   * `null` leaves one out.
   */
  readonly attributes = input<Record<string, string | null>>({});
  /** Typed (or pasted, cut, undone): the text changed by the user. */
  readonly edited = output<void>();
  /** The selection moved without the text changing. */
  readonly caret = output<void>();
  /** Runs before the editor handles the key; `preventDefault` stops it. */
  readonly beforeKey = output<KeyboardEvent>();
  /** Runs before the editor pastes; `preventDefault` stops it. */
  readonly beforePaste = output<ClipboardEvent>();
  readonly blurred = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly placeholderSlot = new Compartment();
  private readonly attributeSlot = new Compartment();
  private readonly view: EditorView;
  private destroyed = false;
  /** Ids of a form field's hints, for `aria-describedby`. */
  private readonly describedBy = signal<string | null>(null);

  // The form field control (see MatFormFieldControl).
  readonly id = `app-markdown-editor-${nextId++}`;
  readonly stateChanges = new Subject<void>();
  readonly ngControl = null;
  readonly required = false;
  readonly disabled = false;
  readonly errorState = false;
  readonly controlType = 'app-markdown-editor';
  readonly placeholder = '';
  focused = false;

  get empty(): boolean {
    return this.view.state.doc.length === 0;
  }

  get shouldLabelFloat(): boolean {
    return this.focused || !this.empty || this.hint() !== '';
  }

  setDescribedByIds(ids: string[]): void {
    this.describedBy.set(ids.length > 0 ? ids.join(' ') : null);
  }

  onContainerClick(): void {
    if (!this.focused) {
      this.view.focus();
    }
  }

  constructor() {
    this.view = new EditorView({
      parent: this.host.nativeElement,
      state: this.createState(''),
    });
    inject(DestroyRef).onDestroy(() => {
      // Removing the editor blurs it: no more events.
      this.destroyed = true;
      this.view.destroy();
      this.stateChanges.complete();
    });
    effect(() => {
      const text = this.text();
      untracked(() => {
        if (text !== this.value) {
          const focused = this.view.hasFocus;
          this.view.setState(this.createState(text));
          if (focused) {
            this.view.focus();
          }
          // Not seen by the update listener: the form field's label.
          this.stateChanges.next();
        }
      });
    });
    effect(() => {
      const extension = this.placeholderExtension();
      untracked(() =>
        this.view.dispatch({
          effects: this.placeholderSlot.reconfigure(extension),
          annotations: programmatic.of(true),
        }),
      );
      this.stateChanges.next();
    });
    effect(() => {
      const extension = this.attributeExtension();
      untracked(() =>
        this.view.dispatch({
          effects: this.attributeSlot.reconfigure(extension),
          annotations: programmatic.of(true),
        }),
      );
    });
    // Measures once the host is laid out (it was created detached).
    afterNextRender(() => this.view.requestMeasure());
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  /**
   * Replaces the text as the user would (undoable), changing only what
   * differs so the selection stays where it was where possible. No
   * `edited` event, like setting a textarea's value.
   */
  set value(next: string) {
    const current = this.value;
    if (next === current) {
      return;
    }
    let start = 0;
    while (
      start < current.length &&
      start < next.length &&
      current[start] === next[start]
    ) {
      start++;
    }
    let end = 0;
    while (
      end < current.length - start &&
      end < next.length - start &&
      current[current.length - 1 - end] === next[next.length - 1 - end]
    ) {
      end++;
    }
    this.view.dispatch({
      changes: {
        from: start,
        to: current.length - end,
        insert: next.slice(start, next.length - end),
      },
      // Its own undo step, not merged with the typing before.
      annotations: [programmatic.of(true), isolateHistory.of('full')],
    });
  }

  get selectionStart(): number {
    return this.view.state.selection.main.from;
  }

  get selectionEnd(): number {
    return this.view.state.selection.main.to;
  }

  setSelectionRange(start: number, end: number): void {
    const length = this.view.state.doc.length;
    this.view.dispatch({
      selection: EditorSelection.range(
        Math.min(start, length),
        Math.min(end, length),
      ),
      scrollIntoView: true,
      annotations: programmatic.of(true),
    });
  }

  focus(): void {
    this.view.focus();
  }

  /** The editable element (for measuring and tests). */
  get contentElement(): HTMLElement {
    return this.view.contentDOM;
  }

  /** Applies a format to the selection and keeps the focus in the editor. */
  format(format: MarkdownFormat): void {
    formatCommand(format)(this.view);
    this.view.focus();
  }

  private createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: this.extensions(),
    });
  }

  private extensions(): Extension {
    return [
      // The page's handlers first: Ctrl+Enter sends, the autocompletes
      // take arrows, Enter and Tab while open, pasted images are attached.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event) => {
            this.beforeKey.emit(event);
            return event.defaultPrevented;
          },
          paste: (event) => {
            this.beforePaste.emit(event);
            return event.defaultPrevented;
          },
          // Dropped files are the page's (images are attached); the editor
          // would insert the text of text-like ones.
          drop: (event) => event.dataTransfer?.types.includes('Files') ?? false,
          blur: () => {
            if (!this.destroyed) {
              this.blurred.emit();
            }
          },
        }),
      ),
      Prec.high(markdownEditing()),
      history(),
      // Without Mod-/ (comments): on German and other layouts Shift+7 types
      // `/`, and CodeMirror tries the typed character first, so Ctrl+Shift+7
      // (numbered list) would wrap the lines in `<!-- -->`.
      keymap.of([
        ...historyKeymap,
        ...defaultKeymap.filter((binding) => binding.run !== toggleComment),
      ]),
      EditorView.lineWrapping,
      editorTheme,
      EditorState.tabSize.of(4),
      this.placeholderSlot.of(this.placeholderExtension()),
      this.attributeSlot.of(this.attributeExtension()),
      EditorView.contentAttributes.of({
        spellcheck: 'true',
        autocorrect: 'on',
        autocapitalize: 'sentences',
        'aria-multiline': 'true',
      }),
      EditorView.updateListener.of((update) => {
        const typed = !update.transactions.some((transaction) =>
          transaction.annotation(programmatic),
        );
        if (update.focusChanged) {
          this.focused = update.view.hasFocus;
          this.stateChanges.next();
        }
        if (update.docChanged) {
          this.stateChanges.next();
          this.text.set(update.state.doc.toString());
          if (typed) {
            this.edited.emit();
          }
        } else if (update.selectionSet && typed) {
          this.caret.emit();
        }
      }),
    ];
  }

  private placeholderExtension(): Extension {
    const text = this.hint();
    return text ? placeholderText(text) : [];
  }

  private attributeExtension(): Extension {
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.attributes())) {
      if (value !== null) {
        attributes[name] = value;
      }
    }
    const describedBy = [attributes['aria-describedby'], this.describedBy()]
      .filter(Boolean)
      .join(' ');
    if (describedBy) {
      attributes['aria-describedby'] = describedBy;
    }
    if (this.suggestion()) {
      attributes['data-suggestion'] = '';
    }
    return EditorView.contentAttributes.of(attributes);
  }
}
