/**
 * Pure helpers for patching the notes-list query cache in place.
 *
 * When a real-time status change arrives for a row that's on screen, we patch
 * that row in the cached pages instead of refetching — so the list never jumps
 * or blinks (the "optimistic row updates" requirement). Kept pure and separate
 * from the component so the merge logic is unit-tested directly.
 */

import type { InfiniteData } from '@tanstack/react-query';
import type { ListResult } from '../data/store.js';
import type { NoteStatus } from '../domain/types.js';

/**
 * Return new InfiniteData with `noteId`'s status set to `toStatus`, touching
 * only the page and row that changed (referential stability elsewhere, so React
 * re-renders just the affected row). A no-op if the note isn't loaded or already
 * has that status.
 */
export function applyStatusToPages(
  data: InfiniteData<ListResult> | undefined,
  noteId: string,
  toStatus: NoteStatus,
): InfiniteData<ListResult> | undefined {
  if (!data) return data;
  let anyChange = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((note) => {
      if (note.id === noteId && note.status !== toStatus) {
        pageChanged = true;
        return { ...note, status: toStatus };
      }
      return note;
    });
    if (!pageChanged) return page;
    anyChange = true;
    return { ...page, items };
  });
  return anyChange ? { ...data, pages } : data;
}
