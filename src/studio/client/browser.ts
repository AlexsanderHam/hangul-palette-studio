/** Browser storage, DOM access, and small presentation helpers. */
const STORAGE_PREFIX = "hangul-palette-studio:v1:";
let toastTimer = 0;

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function readSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

export function writeSessionValue(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSessionValue(key: string): void {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Removing a completed command from restricted browser storage is best effort.
  }
}

export function announce(message: string): void {
  const toast = el("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
