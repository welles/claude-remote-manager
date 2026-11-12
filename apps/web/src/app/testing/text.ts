/**
 * Text of an element with its text nodes joined by single spaces, so that
 * flex layouts without whitespace between children still read as words.
 */
export function words(node: Node | null | undefined): string {
  if (!node) {
    return '';
  }
  const parts: string[] = [];
  const walker = node.ownerDocument?.createTreeWalker(
    node,
    NodeFilter.SHOW_TEXT,
  );
  for (
    let current = walker?.nextNode();
    current;
    current = walker?.nextNode()
  ) {
    const text = current.textContent?.replace(/\s+/g, ' ').trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(' ');
}
