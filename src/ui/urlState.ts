/**
 * URL <-> list state.
 *
 * The brief requires filter, sort and search state to be URL-persisted and
 * deep-linkable. The URL is the single source of truth: components read it and
 * write it, and it doubles as the query key so a shared link reproduces the
 * exact view and stale responses can't clobber a changed query.
 */

import type { NoteStatus } from '../domain/types.js';
import { NOTE_STATUSES } from '../domain/types.js';

export type SortField = 'updatedAt' | 'createdAt' | 'status';
export type SortDir = 'asc' | 'desc';

export interface ListQuery {
  statuses: NoteStatus[];
  assignedReviewerId: string | null;
  search: string;
  /** Inclusive date-range bounds on updatedAt, epoch ms, or null when unset. */
  updatedAfter: number | null;
  updatedBefore: number | null;
  sortField: SortField;
  sortDir: SortDir;
}

export const DEFAULT_QUERY: ListQuery = {
  statuses: [],
  assignedReviewerId: null,
  search: '',
  updatedAfter: null,
  updatedBefore: null,
  sortField: 'updatedAt',
  sortDir: 'desc',
};

/** Reviewers selectable in the filter panel (mirrors the seeded reviewer pool). */
export const REVIEWER_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'usr_chen', label: 'Dr. Chen' },
  { id: 'usr_patel', label: 'Dr. Patel' },
  { id: 'usr_okafor', label: 'Dr. Okafor' },
  { id: 'usr_ramirez', label: 'Dr. Ramirez' },
];

const SORT_FIELDS: SortField[] = ['updatedAt', 'createdAt', 'status'];

export function parseQuery(params: URLSearchParams): ListQuery {
  const statusRaw = params.get('status');
  const statuses = statusRaw
    ? statusRaw.split(',').filter((s): s is NoteStatus => (NOTE_STATUSES as readonly string[]).includes(s))
    : [];

  const sortField = params.get('sort');
  const sortDir = params.get('dir');

  return {
    statuses,
    assignedReviewerId: params.get('reviewer') || null,
    search: params.get('q') ?? '',
    updatedAfter: parseDate(params.get('after')),
    updatedBefore: parseDate(params.get('before')),
    sortField: SORT_FIELDS.includes(sortField as SortField) ? (sortField as SortField) : DEFAULT_QUERY.sortField,
    sortDir: sortDir === 'asc' ? 'asc' : 'desc',
  };
}

/** Parse a yyyy-mm-dd string to epoch ms, or null. */
function parseDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms to yyyy-mm-dd for a date input value. */
export function toDateInput(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Serialize to URLSearchParams, omitting defaults so links stay clean. */
export function toSearchParams(query: ListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.statuses.length > 0) params.set('status', query.statuses.join(','));
  if (query.assignedReviewerId) params.set('reviewer', query.assignedReviewerId);
  if (query.search) params.set('q', query.search);
  if (query.updatedAfter !== null) params.set('after', toDateInput(query.updatedAfter));
  if (query.updatedBefore !== null) params.set('before', toDateInput(query.updatedBefore));
  if (query.sortField !== DEFAULT_QUERY.sortField) params.set('sort', query.sortField);
  if (query.sortDir !== DEFAULT_QUERY.sortDir) params.set('dir', query.sortDir);
  return params;
}

/** A stable, serializable key for the data layer / query cache. */
export function queryKey(query: ListQuery): string {
  return toSearchParams(query).toString();
}
