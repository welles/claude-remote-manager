import { EditorSelection, EditorState } from '@codemirror/state';
import {
  formatCommand,
  indentListItem,
  outdentListItem,
  type MarkdownFormat,
} from './markdown-commands';

/**
 * Text with the selection marked: `[` and `]` around it, or `|` for the
 * caret.
 */
function stateOf(marked: string): EditorState {
  const caret = marked.indexOf('|');
  if (caret >= 0) {
    return EditorState.create({
      doc: marked.replace('|', ''),
      selection: EditorSelection.cursor(caret),
    });
  }
  const from = marked.indexOf('[');
  const to = marked.indexOf(']') - 1;
  return EditorState.create({
    doc: marked.replace('[', '').replace(']', ''),
    selection: EditorSelection.range(from, to),
  });
}

function markedOf(state: EditorState): string {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  return from === to
    ? `${doc.slice(0, from)}|${doc.slice(from)}`
    : `${doc.slice(0, from)}[${doc.slice(from, to)}]${doc.slice(to)}`;
}

function run(
  command: (target: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState['update']>) => void;
  }) => boolean,
  marked: string,
): { result: string; handled: boolean } {
  let state = stateOf(marked);
  const handled = command({
    state,
    dispatch: (transaction) => (state = transaction.state),
  });
  return { result: markedOf(state), handled };
}

const format = (name: MarkdownFormat, marked: string) =>
  run(formatCommand(name), marked).result;

describe('Markdown formatting', () => {
  it('wraps the selection and unwraps it again', () => {
    expect(format('bold', 'a [word] b')).toBe('a **[word]** b');
    expect(format('bold', 'a **[word]** b')).toBe('a [word] b');
    // The markers selected too.
    expect(format('bold', 'a [**word**] b')).toBe('a [word] b');
    expect(format('italic', '[x]')).toBe('_[x]_');
    expect(format('strikethrough', '[x]')).toBe('~~[x]~~');
    expect(format('code', '[x]')).toBe('`[x]`');
  });

  it('puts the caret between an empty pair', () => {
    expect(format('bold', 'a |')).toBe('a **|**');
    // Typed into and toggled again: the empty pair goes.
    expect(format('bold', 'a **|**')).toBe('a |');
  });

  it('does not take bold for two italic markers', () => {
    expect(format('italic', '__[x]__')).toBe('___[x]___');
  });

  it('toggles lists, quotes and tasks on the selected lines', () => {
    expect(format('bullet', '[one\ntwo]')).toBe('[- one\n- two]');
    expect(format('bullet', '[- one\n- two]')).toBe('[one\ntwo]');
    expect(format('numbered', '[one\n\ntwo]')).toBe('[1. one\n\n2. two]');
    // Another list becomes this one.
    expect(format('numbered', '[- one\n- two]')).toBe('[1. one\n2. two]');
    expect(format('task', 'do |it')).toBe('- [ ] do |it');
    expect(format('quote', '|said')).toBe('> |said');
    expect(format('quote', '> |said')).toBe('|said');
    // Nested items keep their indentation.
    expect(format('numbered', '[- a\n  - b]')).toBe('[1. a\n  2. b]');
    // An empty line gets the prefix, the caret after it.
    expect(format('bullet', '|')).toBe('- |');
  });

  it('cycles headings through three levels', () => {
    expect(format('heading', 'Title|')).toBe('# Title|');
    expect(format('heading', '# Title|')).toBe('## Title|');
    expect(format('heading', '## Title|')).toBe('### Title|');
    expect(format('heading', '### Title|')).toBe('Title|');
  });

  it('makes links of text and of URLs', () => {
    expect(format('link', 'see [docs]')).toBe('see [docs]([url])');
    expect(format('link', '[https://example.com]')).toBe(
      '[|](https://example.com)',
    );
    expect(format('link', 'a |')).toBe('a [|](url)');
  });

  it('fences code blocks', () => {
    expect(format('codeBlock', '|')).toBe('```\n|\n```');
    expect(format('codeBlock', 'text|')).toBe('text\n```\n|\n```');
    expect(format('codeBlock', '[a\nb]')).toBe('```\n[a\nb]\n```');
  });
});

describe('List indentation', () => {
  it('nests an item under the one before, to its text', () => {
    expect(run(indentListItem, '- a\n- |b').result).toBe('- a\n  - |b');
    expect(run(indentListItem, '1. a\n2. |b').result).toBe('1. a\n   2. |b');
    // The first item cannot be nested, but Tab stays in the list.
    expect(run(indentListItem, '- |a')).toEqual({
      result: '- |a',
      handled: true,
    });
  });

  it('moves an item out by one level', () => {
    expect(run(outdentListItem, '- a\n  - b\n    - |c').result).toBe(
      '- a\n  - b\n  - |c',
    );
    expect(run(outdentListItem, '- a\n  - |b').result).toBe('- a\n- |b');
  });

  it('leaves Tab alone outside lists', () => {
    expect(run(indentListItem, 'plain |text').handled).toBe(false);
    expect(run(outdentListItem, 'plain |text').handled).toBe(false);
  });
});
