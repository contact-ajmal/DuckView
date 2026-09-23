import { create } from 'zustand';

/** Open state of the command palette (⌘K), shared by the top bar and the keyboard shortcut. */
export const usePalette = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
