import { toast } from "sonner";

export async function writeClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch { /* HTTP and restricted browsers use the selection fallback. */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
  // Keep focus inside a modal's focus trap while copying.
  (previous?.closest('[role="dialog"]') ?? document.body).appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请选中内容后手动复制");
  } finally {
    textarea.remove();
    previous?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach((range) => selection?.addRange(range));
  }
}

export async function copyText(value: string, success = "已复制到剪贴板"): Promise<void> {
  try {
    await writeClipboard(value);
    toast.success(success);
  } catch {
    toast.error("复制失败，请选中内容后手动复制");
  }
}
