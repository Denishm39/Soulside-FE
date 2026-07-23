/**
 * Data hooks — TanStack Query over the API interface.
 *
 * The infinite query is keyed by the serialized URL state, so a filter/sort
 * change is a new key (fresh fetch, stale responses discarded) and a shared
 * link reproduces the exact view. Cursor pagination maps directly onto
 * getNextPageParam.
 */

import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { useRuntime } from './RuntimeContext.js';
import { queryKey, type ListQuery } from './urlState.js';
import type { ListResult, NoteRecord } from '../data/store.js';

const PAGE_SIZE = 50;

export function useNotesList(query: ListQuery) {
  const { api } = useRuntime();
  return useInfiniteQuery<ListResult, Error, InfiniteData<ListResult>, [string, string], string | null>({
    queryKey: ['notes', queryKey(query)],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      api.listNotes({
        statuses: query.statuses,
        // Omit optional keys entirely when unset (exactOptionalPropertyTypes).
        ...(query.assignedReviewerId !== null ? { assignedReviewerId: query.assignedReviewerId } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.updatedAfter !== null ? { updatedAfter: query.updatedAfter } : {}),
        ...(query.updatedBefore !== null ? { updatedBefore: query.updatedBefore } : {}),
        sortField: query.sortField,
        sortDir: query.sortDir,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.cursor.next,
  });
}

export function useNote(id: string | undefined) {
  const { api } = useRuntime();
  return useQuery<NoteRecord, Error>({
    queryKey: ['note', id],
    queryFn: () => api.getNote(id as string),
    enabled: Boolean(id),
  });
}
