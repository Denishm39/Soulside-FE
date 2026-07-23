/**
 * Opaque cursor pagination.
 *
 * The brief is explicit: pagination is cursor-based, and the client must not
 * assume offset semantics or stable ordering across pages. So the cursor
 * encodes the *sort position* of the last row returned — an (updatedAt, id)
 * pair — not a numeric offset. The next page is "everything ordered after this
 * position", which stays correct even as rows are inserted or reordered
 * between requests.
 *
 * The token is base64 of a JSON keyset. It is deliberately opaque: callers pass
 * it back verbatim and never parse it. Encoding the sort key (not an index) is
 * what prevents the classic offset bug where an insert shifts every later page.
 */

export interface Keyset {
  /** Primary sort value of the last row on the page. Epoch ms for updatedAt. */
  sortValue: number;
  /** Secondary, stable tiebreak so equal sortValues never drop or duplicate rows. */
  id: string;
}

export function encodeCursor(key: Keyset): string {
  const json = JSON.stringify([key.sortValue, key.id]);
  return base64Encode(json);
}

export function decodeCursor(token: string): Keyset | null {
  try {
    const parsed = JSON.parse(base64Decode(token)) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'string'
    ) {
      return { sortValue: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Total order over the keyset. Descending by sortValue (newest first), then
 * ascending by id as a stable tiebreak. A row belongs on a page *after* the
 * cursor iff it compares strictly greater than the cursor under this order.
 */
export function compareKeyset(a: Keyset, b: Keyset): number {
  if (a.sortValue !== b.sortValue) return b.sortValue - a.sortValue;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Is `row` strictly after `cursor` in sort order (i.e. eligible for the next page)? */
export function isAfter(cursor: Keyset, row: Keyset): boolean {
  return compareKeyset(cursor, row) < 0;
}

// --- base64 that works in both browser and Node without a polyfill ------------

function base64Encode(s: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, 'utf-8').toString('base64');
}

function base64Decode(s: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
  return Buffer.from(s, 'base64').toString('utf-8');
}
