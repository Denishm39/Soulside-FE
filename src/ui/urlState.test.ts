import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, parseQuery, queryKey, toSearchParams, type ListQuery } from './urlState.js';

const roundTrip = (q: ListQuery): ListQuery => parseQuery(new URLSearchParams(toSearchParams(q).toString()));

describe('urlState', () => {
  it('omits defaults so a clean view has an empty query string', () => {
    expect(toSearchParams(DEFAULT_QUERY).toString()).toBe('');
  });

  it('round-trips status, reviewer, search, sort', () => {
    const q: ListQuery = {
      statuses: ['IN_REVIEW', 'APPROVED'],
      assignedReviewerId: 'usr_chen',
      search: 'chest pain',
      updatedAfter: null,
      updatedBefore: null,
      sortField: 'createdAt',
      sortDir: 'asc',
    };
    expect(roundTrip(q)).toEqual(q);
  });

  it('round-trips a date range at day granularity', () => {
    const q: ListQuery = {
      ...DEFAULT_QUERY,
      updatedAfter: Date.parse('2025-11-01'),
      updatedBefore: Date.parse('2025-11-30'),
    };
    const back = roundTrip(q);
    expect(back.updatedAfter).toBe(Date.parse('2025-11-01'));
    expect(back.updatedBefore).toBe(Date.parse('2025-11-30'));
  });

  it('ignores unknown/garbage status values', () => {
    const parsed = parseQuery(new URLSearchParams('status=IN_REVIEW,NONSENSE'));
    expect(parsed.statuses).toEqual(['IN_REVIEW']);
  });

  it('produces a stable key usable for the query cache', () => {
    const a = queryKey({ ...DEFAULT_QUERY, statuses: ['IN_REVIEW'] });
    const b = queryKey({ ...DEFAULT_QUERY, statuses: ['IN_REVIEW'] });
    expect(a).toBe(b);
    expect(queryKey(DEFAULT_QUERY)).toBe('');
  });
});
