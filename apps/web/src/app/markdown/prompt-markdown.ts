import { Marked } from 'marked';
import { withoutRemoteResources } from '../sessions/markdown.pipe';

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/**
 * Markdown as the user writes it: GitHub's flavour, a line break where
 * one was typed, and HTML shown as typed (a prompt mentioning `<button>`
 * means the text, not an element). Task boxes are characters: the
 * sanitizer would drop checkbox inputs.
 */
const prompts = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // A block keeps its lines, as typed.
    html: ({ text, block }) =>
      block
        ? `<p>${escapeHtml(text.trimEnd()).replaceAll('\n', '<br>')}</p>`
        : escapeHtml(text),
    checkbox: ({ checked }) => (checked ? '☑ ' : '☐ '),
  },
});

/**
 * Renders a user's message to HTML without remote resources; the result
 * still needs Angular's sanitizer.
 */
export function renderPromptMarkdown(text: string): string {
  return withoutRemoteResources(prompts.parse(text, { async: false }).trim());
}
