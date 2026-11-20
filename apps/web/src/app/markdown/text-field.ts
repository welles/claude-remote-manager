/**
 * What the autocompletes (`@`, `#`, `/`) need of a text field: its text,
 * the selection and setting both. Textareas and the Markdown editor have
 * it.
 */
export interface TextField {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
}
