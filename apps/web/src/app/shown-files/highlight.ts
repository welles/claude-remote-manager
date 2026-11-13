/**
 * Syntax highlighting with highlight.js (its common languages plus a few
 * more), loaded on first use so it stays out of the app's bundles until a
 * file is viewed. Returns HTML with escaped text in `hljs-*` spans.
 */
export async function highlight(
  text: string,
  language: string | null,
): Promise<string> {
  const { default: hljs } = await import('highlight.js/lib/common');
  if (language === 'nix' && !hljs.getLanguage('nix')) {
    const { default: nix } = await import('highlight.js/lib/languages/nix');
    hljs.registerLanguage('nix', nix);
  }
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }
  // Guessing is slow on large files.
  return text.length <= 100_000
    ? hljs.highlightAuto(text).value
    : escapeHtml(text);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
