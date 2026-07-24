import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import { applyStatusToPages } from './listCache.js';
import type { ListResult, NoteRecord } from '../data/store.js';

const note = (id: string, status: NoteRecord['status']): NoteRecord => ({
  id,
  patient: { id: `pat_${id}`, displayName: id },
  status,
  assignedReviewerId: null,
  currentVersionId: `v_${id}`,
  approvedAt: null,
  createdAt: 0,
  updatedAt: 0,
  versions: [],
  events: [],
});

const page = (items: NoteRecord[]): ListResult => ({
  items,
  cursor: { next: null, hasMore: false },
  meta: { total: items.length, returned: items.length, generatedAt: 0 },
});

const data = (...pages: ListResult[]): InfiniteData<ListResult> => ({
  pages,
  pageParams: pages.map(() => null),
});

describe('applyStatusToPages', () => {
  it('updates the matching row across pages', () => {
    const input = data(page([note('a', 'READY_FOR_REVIEW')]), page([note('b', 'READY_FOR_REVIEW')]));
    const out = applyStatusToPages(input, 'b', 'IN_REVIEW');
    expect(out?.pages[1]?.items[0]?.status).toBe('IN_REVIEW');
    expect(out?.pages[0]?.items[0]?.status).toBe('READY_FOR_REVIEW'); // untouched
  });

  it('is a no-op (same reference) when the note is absent', () => {
    const input = data(page([note('a', 'READY_FOR_REVIEW')]));
    expect(applyStatusToPages(input, 'zzz', 'IN_REVIEW')).toBe(input);
  });

  it('is a no-op when the status already matches', () => {
    const input = data(page([note('a', 'IN_REVIEW')]));
    expect(applyStatusToPages(input, 'a', 'IN_REVIEW')).toBe(input);
  });

  it('keeps unaffected pages referentially stable (minimal re-render)', () => {
    const p0 = page([note('a', 'READY_FOR_REVIEW')]);
    const p1 = page([note('b', 'READY_FOR_REVIEW')]);
    const input = data(p0, p1);
    const out = applyStatusToPages(input, 'b', 'APPROVED');
    expect(out?.pages[0]).toBe(p0); // page 0 unchanged reference
    expect(out?.pages[1]).not.toBe(p1); // page 1 is a new object
  });

  it('handles undefined data', () => {
    expect(applyStatusToPages(undefined, 'a', 'IN_REVIEW')).toBeUndefined();
  });
});
