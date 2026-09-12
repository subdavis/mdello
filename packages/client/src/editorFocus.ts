export function focusEditorAtLine(
  area: HTMLTextAreaElement,
  editorStack: HTMLElement,
  source: string,
  line = 0,
): void {
  const offset = source
    .split('\n')
    .slice(0, line)
    .reduce((sum, text) => sum + text.length + 1, 0);

  // Set the caret first and prevent focus from scrolling to the textarea's default end position.
  area.setSelectionRange(offset, offset);
  area.focus({ preventScroll: true });

  const scroller = editorStack.closest<HTMLElement>('.card-content') ?? editorStack;
  const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 1;
  const stackTop =
    editorStack.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;
  scroller.scrollTop = Math.max(0, stackTop + line * lineHeight - scroller.clientHeight / 3);
}
