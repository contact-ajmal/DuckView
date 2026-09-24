import { useEffect, type RefObject } from 'react';

/** Whether the last input was the keyboard (menus then land on their first item). */
let keyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey) keyboard = true; }, true);
  window.addEventListener('pointerdown', () => { keyboard = false; }, true);
}
export const usingKeyboard = () => keyboard;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elements inside `root` that take keyboard focus, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * While `active`: moves focus into the element (its `[data-autofocus]` child, else the first focusable), keeps Tab
 * inside it, and on close returns focus to whatever had it before (the trigger).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    // The close button is last resort: land on the content (a field, the main action).
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root).find((el) => !el.hasAttribute('data-close')) ?? focusables(root)[0] ?? root;
    // After paint, so children that mount with the dialog exist.
    const t = requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) first.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (i <= 0)) {
        e.preventDefault();
        items[items.length - 1]!.focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0]!.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(t);
      root.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

/** Arrow-key movement between the items of a list-like widget (menus, tab lists). */
export function moveFocus(items: HTMLElement[], current: Element | null, key: string, orientation: 'vertical' | 'horizontal'): boolean {
  const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const prev = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  if (![next, prev, 'Home', 'End'].includes(key) || !items.length) return false;
  const i = items.indexOf(current as HTMLElement);
  const to = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : key === next ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[to]!.focus();
  return true;
}
