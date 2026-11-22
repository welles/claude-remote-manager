import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state';

/** Markers that wrap inline text: bold, italic, strikethrough, code. */
export type InlineFormat = 'bold' | 'italic' | 'strikethrough' | 'code';

/** Prefixes that start a line: lists, quotes, headings. */
export type LineFormat = 'bullet' | 'numbered' | 'task' | 'quote' | 'heading';

/** Everything the toolbar and the shortcuts offer. */
export type MarkdownFormat = InlineFormat | LineFormat | 'link' | 'codeBlock';

const MARKERS: Record<InlineFormat, string> = {
  bold: '**',
  italic: '_',
  strikethrough: '~~',
  code: '`',
};

/** A list item's marker with its indentation and the space after it. */
const LIST_ITEM =
  /^(\s*)([-*+]|\d+[.)])(\s+)(?!(?:[-*+]\s*){2,}$)(\[[ xX]\]\s+)?/;

/** Any prefix a line format may have put there (replaced by another one). */
const LINE_PREFIX =
  /^(\s*)(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?|#{1,6}\s+)?/;

const PREFIX_OF: Record<Exclude<LineFormat, 'numbered' | 'heading'>, RegExp> = {
  bullet: /^\s*[-*+]\s+(?!\[[ xX]\])/,
  task: /^\s*[-*+]\s+\[[ xX]\]\s+/,
  quote: /^\s*>\s?/,
};

/**
 * Wraps each selection in the marker, or unwraps it when it is wrapped
 * already (the marker inside or just outside the selection). An empty
 * selection gets an empty pair with the caret between.
 */
function toggleInline(state: EditorState, format: InlineFormat) {
  const marker = MARKERS[format];
  const size = marker.length;
  // Italic typed as `*x*` unwraps as well.
  const markers = format === 'italic' ? [marker, '*'] : [marker];
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    for (const wrap of markers) {
      if (
        text.length >= 2 * size &&
        text.startsWith(wrap) &&
        text.endsWith(wrap) &&
        !(format === 'italic' && text.startsWith(wrap.repeat(2)))
      ) {
        return {
          changes: [
            { from: range.from, to: range.from + size },
            { from: range.to - size, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - 2 * size),
        };
      }
      if (
        state.sliceDoc(range.from - size, range.from) === wrap &&
        state.sliceDoc(range.to, range.to + size) === wrap &&
        // `**` around the caret is bold, not two italic markers.
        !(format === 'italic' && isPartOfLongerRun(state, range, wrap))
      ) {
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      }
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + size, range.to + size),
    };
  });
}

function isPartOfLongerRun(
  state: EditorState,
  range: SelectionRange,
  marker: string,
): boolean {
  const size = marker.length;
  return (
    state.sliceDoc(range.from - 2 * size, range.from - size) === marker ||
    state.sliceDoc(range.to + size, range.to + 2 * size) === marker
  );
}

/** The lines the selection touches, each once. */
function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = [];
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
      if (!lines.some((line) => line.number === n)) {
        lines.push(state.doc.line(n));
      }
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

/** `- - -`, `***`: a horizontal rule, no list item. */
const isBreak = (text: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(text);

function hasLineFormat(line: Line, format: LineFormat): boolean {
  if (isBreak(line.text)) {
    return false;
  }
  if (format === 'numbered') {
    return /^\s*\d+[.)]\s+/.test(line.text);
  }
  if (format === 'heading') {
    return /^#{1,6}\s+/.test(line.text);
  }
  return PREFIX_OF[format].test(line.text);
}

/** The next heading level: none → `#` → `##` → `###` → none. */
function nextHeading(line: Line): string {
  const level = /^(#{1,6})\s+/.exec(line.text)?.[1].length ?? 0;
  return level >= 3 ? '' : `${'#'.repeat(level + 1)} `;
}

/**
 * Gives the selected lines a list, quote or heading prefix, replacing
 * another one they have; when all have it already, removes it. Headings
 * cycle through three levels. Empty lines between selected ones stay empty.
 */
function toggleLines(state: EditorState, format: LineFormat) {
  const lines = selectedLines(state);
  const remove =
    format !== 'heading' &&
    lines
      .filter((line) => line.text.trim() !== '' || lines.length === 1)
      .every((line) => hasLineFormat(line, format));
  const changes: ChangeSpec[] = [];
  let number = 1;
  for (const line of lines) {
    if (line.text.trim() === '' && lines.length > 1) {
      continue;
    }
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    const existing = isBreak(line.text)
      ? indent
      : (LINE_PREFIX.exec(line.text)?.[0] ?? '');
    let prefix: string;
    if (remove) {
      prefix = indent;
    } else if (format === 'heading') {
      prefix = nextHeading(line);
    } else if (format === 'numbered') {
      prefix = `${indent}${number++}. `;
    } else {
      prefix = `${indent}${{ bullet: '- ', task: '- [ ] ', quote: '> ' }[format]}`;
    }
    if (prefix !== existing) {
      changes.push({
        from: line.from,
        to: line.from + existing.length,
        insert: prefix,
      });
    }
  }
  const changeSet = state.changes(changes);
  // A caret goes after a new prefix; a selection from the start of a line
  // keeps the prefix inside.
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) => {
      const fromLineStart =
        !range.empty && state.doc.lineAt(range.from).from === range.from;
      return EditorSelection.range(
        changeSet.mapPos(
          range.anchor,
          range.anchor === range.from && fromLineStart ? -1 : 1,
        ),
        changeSet.mapPos(
          range.head,
          range.head === range.from && fromLineStart ? -1 : 1,
        ),
      );
    }),
    state.selection.mainIndex,
  );
  return { changes: changeSet, selection };
}

const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;

/**
 * `[text](url)`: the selected text becomes the link's text and `url` is
 * selected to be typed over; a selected URL becomes the link's target and
 * the caret goes into its (empty) text. Inside a link, it becomes its text
 * again.
 */
function insertLink(state: EditorState) {
  return state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    for (const match of line.text.matchAll(LINK)) {
      const from = line.from + (match.index ?? 0);
      const to = from + match[0].length;
      if (range.from >= from && range.to <= to) {
        return {
          changes: { from, to, insert: match[1] },
          range: EditorSelection.range(from, from + match[1].length),
        };
      }
    }
    const text = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}](url)`;
    const urlFrom = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text
        ? EditorSelection.range(urlFrom, urlFrom + 3)
        : EditorSelection.cursor(range.from + 1),
    };
  });
}

const FENCE = /^\s*(```|~~~)/;

/**
 * Puts the selected lines between ``` fences (on lines of their own); an
 * empty selection gets an empty block with the caret inside. Lines with
 * fences right around them lose them.
 */
function insertCodeBlock(state: EditorState) {
  return state.changeByRange((range) => {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    if (first.number > 1 && last.number < state.doc.lines) {
      const before = state.doc.line(first.number - 1);
      const after = state.doc.line(last.number + 1);
      if (FENCE.test(before.text) && /^\s*(```|~~~)\s*$/.test(after.text)) {
        const removed = before.length + 1;
        return {
          changes: [
            { from: before.from, to: first.from },
            { from: last.to, to: after.to },
          ],
          range: EditorSelection.range(
            range.from - removed,
            range.to - removed,
          ),
        };
      }
    }
    if (range.empty && first.text.trim() === '') {
      return {
        changes: { from: first.from, to: first.to, insert: '```\n\n```' },
        range: EditorSelection.cursor(first.from + 4),
      };
    }
    if (range.empty) {
      const insert = `\n\`\`\`\n\n\`\`\``;
      return {
        changes: { from: first.to, insert },
        range: EditorSelection.cursor(first.to + 5),
      };
    }
    return {
      changes: [
        { from: first.from, insert: '```\n' },
        { from: last.to, insert: '\n```' },
      ],
      range: EditorSelection.range(range.from + 4, range.to + 4),
    };
  });
}

/** Applies a format to the selection (toolbar and shortcuts). */
export function formatCommand(format: MarkdownFormat): StateCommand {
  return ({ state, dispatch }) => {
    let spec;
    switch (format) {
      case 'link':
        spec = insertLink(state);
        break;
      case 'codeBlock':
        spec = insertCodeBlock(state);
        break;
      case 'bullet':
      case 'numbered':
      case 'task':
      case 'quote':
      case 'heading':
        spec = toggleLines(state, format);
        break;
      default:
        spec = toggleInline(state, format);
    }
    dispatch(
      state.update(spec, {
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

/** The list item on a line: indentation and the width of its marker. */
function listItem(text: string): { indent: number; width: number } | null {
  const match = LIST_ITEM.exec(text);
  return match
    ? {
        indent: match[1].length,
        width: match[2].length + match[3].length,
      }
    : null;
}

/**
 * The nearest list item above a line that `wanted` accepts, looking past
 * blank lines, continuation text (indented) and deeper items; `null` once
 * the list has ended.
 */
function itemBefore(
  state: EditorState,
  number: number,
  wanted: (item: { indent: number; width: number }) => boolean,
): { indent: number; width: number } | null {
  for (let n = number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    const item = listItem(text);
    if (item) {
      if (wanted(item)) {
        return item;
      }
      continue;
    }
    if (text.trim() !== '' && !/^\s/.test(text)) {
      return null;
    }
  }
  return null;
}

/** Whether every selected line is a list item. */
function inList(state: EditorState): boolean {
  return selectedLines(state).every((line) => listItem(line.text) !== null);
}

/**
 * Tab in a list: nests the selected items under the item before them
 * (indented to its text, as Markdown needs). Outside lists, and where
 * nothing can be nested (the first item of a list), nothing: Tab keeps
 * its usual meaning.
 */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  if (!inList(state)) {
    return false;
  }
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(state)) {
    const item = listItem(line.text);
    if (!item) {
      continue;
    }
    // The previous item at the same depth: nest under its text.
    const previous = itemBefore(
      state,
      line.number,
      (other) => other.indent <= item.indent,
    );
    if (previous?.indent === item.indent) {
      changes.push({ from: line.from, insert: ' '.repeat(previous.width) });
    }
  }
  // Nothing to move: the key keeps its usual meaning (focus), so the
  // editor never traps the keyboard.
  if (changes.length === 0) {
    return false;
  }
  dispatch(state.update({ changes, userEvent: 'input.indent' }));
  return true;
};

/**
 * Shift+Tab in a list: moves the selected items out by one level (to the
 * indentation of the item they are nested in). Where nothing is nested,
 * nothing: Shift+Tab keeps its usual meaning.
 */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  if (!inList(state)) {
    return false;
  }
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(state)) {
    const item = listItem(line.text);
    if (!item || item.indent === 0) {
      continue;
    }
    const parent = itemBefore(
      state,
      line.number,
      (other) => other.indent < item.indent,
    );
    const target = parent?.indent ?? 0;
    changes.push({ from: line.from + target, to: line.from + item.indent });
  }
  // Nothing to move: the key keeps its usual meaning (focus), so the
  // editor never traps the keyboard.
  if (changes.length === 0) {
    return false;
  }
  dispatch(state.update({ changes, userEvent: 'delete.dedent' }));
  return true;
};
