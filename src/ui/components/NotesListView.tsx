/**
 * Notes list — cursor-paginated, virtualized, URL-driven.
 *
 * - filters/sort/search live in the URL (deep-linkable, and the query key);
 * - rows are virtualized so 100k notes never all render;
 * - infinite scroll fetches the next cursor page near the end;
 * - selection lives in a store, so it survives paging and filter changes;
 * - empty vs no-results are distinct states.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNotesList } from '../hooks.js';
import { useSelection } from '../selectionStore.js';
import { parseQuery, toSearchParams, DEFAULT_QUERY, type SortField } from '../urlState.js';
import { NOTE_STATUSES, type NoteStatus } from '../../domain/types.js';
import type { NoteRecord } from '../../data/store.js';

const ROW_HEIGHT = 56;

export function NotesListView(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => parseQuery(searchParams), [searchParams]);

  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotesList(query);

  const rows: NoteRecord[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.meta.total ?? 0;
  const hasActiveFilter = query.statuses.length > 0 || query.search !== '' || query.assignedReviewerId !== null;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Fetch the next page when the tail scrolls into view.
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 5 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [items, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const patch = (next: Partial<typeof query>) =>
    setSearchParams(toSearchParams({ ...query, ...next }), { replace: true });

  return (
    <div className="list-view">
      <Filters query={query} onChange={patch} />
      <BulkBar />
      <SortHeader field={query.sortField} dir={query.sortDir} onSort={(sortField, sortDir) => patch({ sortField, sortDir })} />

      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <p className="state state--error" role="alert">
          Couldn’t load notes: {error.message}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState filtered={hasActiveFilter} query={query.search} />
      ) : (
        <>
          <p className="list-count" aria-live="polite">
            {total.toLocaleString()} notes
          </p>
          <div ref={parentRef} className="list-scroll" tabIndex={0} aria-label="Notes">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((v) => {
                const note = rows[v.index];
                if (!note) return null;
                return (
                  <div
                    key={note.id}
                    className="row-wrap"
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                  >
                    <Row note={note} />
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ note }: { note: NoteRecord }): JSX.Element {
  const selected = useSelection((s) => s.selected.has(note.id));
  const toggle = useSelection((s) => s.toggle);
  return (
    <div className={`row ${selected ? 'row--selected' : ''}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => toggle(note.id)}
        aria-label={`Select note for ${note.patient.displayName}`}
      />
      <Link to={`/notes/${note.id}`} className="row-main">
        <span className="row-patient">{note.patient.displayName}</span>
        <span className={`status status--${note.status}`}>{note.status.replace(/_/g, ' ')}</span>
        <span className="row-rev">rev {note.versions.length}</span>
      </Link>
    </div>
  );
}

function Filters({ query, onChange }: { query: ReturnType<typeof parseQuery>; onChange: (n: Partial<ReturnType<typeof parseQuery>>) => void }): JSX.Element {
  return (
    <div className="filters">
      <input
        type="search"
        className="search"
        placeholder="Search patient or note content"
        defaultValue={query.search}
        onChange={(e) => debounceSearch(e.target.value, (v) => onChange({ search: v }))}
        aria-label="Search notes"
      />
      <fieldset className="status-filter">
        <legend className="sr-only">Filter by status</legend>
        {NOTE_STATUSES.map((s) => (
          <label key={s} className={`chip ${query.statuses.includes(s) ? 'chip--on' : ''}`}>
            <input
              type="checkbox"
              checked={query.statuses.includes(s)}
              onChange={(e) => {
                const set = new Set(query.statuses);
                if (e.target.checked) set.add(s);
                else set.delete(s);
                onChange({ statuses: [...set] as NoteStatus[] });
              }}
            />
            {s.replace(/_/g, ' ').toLowerCase()}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function debounceSearch(value: string, apply: (v: string) => void): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => apply(value), 300);
}

function SortHeader({ field, dir, onSort }: { field: SortField; dir: 'asc' | 'desc'; onSort: (f: SortField, d: 'asc' | 'desc') => void }): JSX.Element {
  const cols: Array<{ f: SortField; label: string }> = [
    { f: 'updatedAt', label: 'Updated' },
    { f: 'createdAt', label: 'Created' },
    { f: 'status', label: 'Status' },
  ];
  return (
    <div className="sort-header">
      {cols.map(({ f, label }) => {
        const active = field === f;
        return (
          <button
            key={f}
            type="button"
            className={`sort-btn ${active ? 'is-active' : ''}`}
            aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => onSort(f, active && dir === 'desc' ? 'asc' : 'desc')}
          >
            {label} {active ? (dir === 'desc' ? '▼' : '▲') : ''}
          </button>
        );
      })}
    </div>
  );
}

function BulkBar(): JSX.Element | null {
  const count = useSelection((s) => s.selected.size);
  const clear = useSelection((s) => s.clear);
  if (count === 0) return null;
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <span>{count} selected</span>
      <button type="button" onClick={() => alert('Assign reviewer (demo)')}>Assign reviewer</button>
      <button type="button" onClick={() => alert('Request regeneration (demo)')}>Request regeneration</button>
      <button type="button" onClick={clear}>Clear</button>
    </div>
  );
}

function EmptyState({ filtered, query }: { filtered: boolean; query: string }): JSX.Element {
  // Distinct: nothing-here vs no-results-for-a-search.
  return filtered ? (
    <p className="state state--empty">No notes match {query ? `“${query}”` : 'these filters'}.</p>
  ) : (
    <p className="state state--empty">No notes yet.</p>
  );
}

function SkeletonRows(): JSX.Element {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="row skeleton" style={{ height: ROW_HEIGHT }} />
      ))}
    </div>
  );
}
