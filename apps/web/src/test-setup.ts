// jsdom has no layout: CodeMirror measures text through ranges, which
// jsdom lacks. Empty rectangles let it run (nothing is laid out anyway).
const emptyRects = () => {
  const rects: DOMRect[] = [];
  return Object.assign(rects, { item: () => null }) as unknown as DOMRectList;
};
const emptyRect = () => new DOMRect(0, 0, 0, 0);
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= emptyRect;
}
