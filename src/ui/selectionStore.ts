/**
 * Bulk-selection store.
 *
 * Selection is a set of note ids held outside row state, so it survives
 * pagination and filter changes (the rows unmount and remount, the selection
 * does not). Zustand keeps it a small global the list header and rows share.
 */

import { create } from 'zustand';

interface SelectionState {
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  setMany: (ids: string[], on: boolean) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
}

export const useSelection = create<SelectionState>((set, get) => ({
  selected: new Set<string>(),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),
  setMany: (ids, on) =>
    set((s) => {
      const next = new Set(s.selected);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { selected: next };
    }),
  clear: () => set({ selected: new Set<string>() }),
  isSelected: (id) => get().selected.has(id),
}));
