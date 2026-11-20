import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Drives a Markdown editor (CodeMirror) in tests as a user would: typing
 * replaces the text and places the caret, keys go through the editor's
 * handlers. `testId` is the `data-testid` of its editable element.
 */
export class EditorDriver {
  constructor(
    private readonly root: HTMLElement,
    private readonly testId = 'message-input',
  ) {}

  /** The editable element (ARIA attributes, focus). */
  get element(): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(
      `[data-testid="${this.testId}"]`,
    );
    if (!element) {
      throw new Error(`no editor ${this.testId}`);
    }
    return element;
  }

  get view(): EditorView {
    const view = EditorView.findFromDOM(this.element);
    if (!view) {
      throw new Error(`no editor view for ${this.testId}`);
    }
    return view;
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  get selectionStart(): number {
    return this.view.state.selection.main.from;
  }

  /** The placeholder shown (the empty editor's), else `null`. */
  get placeholder(): string | null {
    return this.view.dom.querySelector('.cm-placeholder')?.textContent ?? null;
  }

  /** Types: the text replaces the editor's, the caret at `caret`. */
  type(text: string, caret = text.length): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(caret),
      userEvent: 'input.type',
    });
  }

  /** Moves the caret (a click or arrow key). */
  moveCaret(position: number): void {
    this.view.dispatch({
      selection: EditorSelection.cursor(position),
      userEvent: 'select',
    });
  }

  /** Presses a key; returns the event (`defaultPrevented`). */
  press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    this.view.contentDOM.dispatchEvent(event);
    return event;
  }

  focus(): void {
    this.view.focus();
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }
}
