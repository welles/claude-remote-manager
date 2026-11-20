import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdownLanguage,
} from '@codemirror/lang-markdown';
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
  formatCommand,
  indentListItem,
  outdentListItem,
  type MarkdownFormat,
} from './markdown-commands';

/**
 * Shortcuts as on GitHub where it has them; `Mod` is Ctrl, or Cmd on a Mac.
 * Shifted keys match by key code, so `Mod-Shift-8` works on any layout.
 */
export const FORMAT_SHORTCUTS: Partial<Record<MarkdownFormat, string>> = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  strikethrough: 'Mod-Shift-x',
  code: 'Mod-e',
  link: 'Mod-k',
  bullet: 'Mod-Shift-8',
  numbered: 'Mod-Shift-7',
  quote: 'Mod-Shift-.',
};

/**
 * The syntax stays visible, the text looks like what it means: headings
 * larger, bold bold, code in the code font; the marks themselves muted.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.2em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.1em', fontWeight: '700' },
  {
    tag: [tags.heading4, tags.heading5, tags.heading6],
    fontWeight: '700',
  },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.quote, class: 'cm-md-quote-text' },
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
  { tag: tags.contentSeparator, class: 'cm-md-mark' },
  { tag: tags.atom, class: 'cm-md-mark' },
]);

const codeLine = Decoration.line({ class: 'cm-md-code-block' });
const quoteLine = Decoration.line({ class: 'cm-md-quote' });

/** Code blocks and quotes are styled by whole lines (background, border). */
function blockLines(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const lines = new Map<number, Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const decoration =
          node.name === 'FencedCode' || node.name === 'CodeBlock'
            ? codeLine
            : node.name === 'Blockquote'
              ? quoteLine
              : null;
        if (!decoration) {
          return;
        }
        const first = view.state.doc.lineAt(node.from).number;
        const last = view.state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          // Code inside a quote: the code style wins.
          if (lines.get(n) !== codeLine) {
            lines.set(n, decoration);
          }
        }
      },
    });
  }
  for (const n of [...lines.keys()].sort((a, b) => a - b)) {
    const line = view.state.doc.line(n);
    builder.add(line.from, line.from, lines.get(n) as Decoration);
  }
  return builder.finish();
}

const blockStyles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = blockLines(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = blockLines(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const formatKeys: KeyBinding[] = Object.entries(FORMAT_SHORTCUTS).map(
  ([format, key]) => ({
    key,
    run: formatCommand(format as MarkdownFormat),
    preventDefault: true,
  }),
);

/**
 * Markdown with GitHub's extensions (tables, task lists, strikethrough),
 * live styling, Enter continuing lists and quotes (and ending them on an
 * empty item), Backspace removing list marks, Tab and Shift+Tab nesting
 * list items (elsewhere Tab is left to the browser and the page), and the
 * formatting shortcuts.
 */
export function markdownEditing(): Extension {
  return [
    markdownLanguage,
    syntaxHighlighting(markdownHighlight),
    blockStyles,
    keymap.of([
      // An empty item ends the list (instead of loosening it).
      {
        key: 'Enter',
        run: insertNewlineContinueMarkupCommand({ nonTightLists: false }),
      },
      { key: 'Backspace', run: deleteMarkupBackward },
      { key: 'Tab', run: indentListItem, shift: outdentListItem },
      ...formatKeys,
    ]),
  ];
}
