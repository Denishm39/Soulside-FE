/**
 * Word-level text diff.
 *
 * Produces the token-level change list the version-history view and the merge
 * UI render. Pure and dependency-free: a longest-common-subsequence over word
 * tokens, which reads cleanly for prose (the SOAP sections) far better than a
 * character diff would.
 *
 * Character-level is available as a refinement on the changed spans (see
 * `refineToChars`) — the brief marks that a plus, not a requirement.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSpan {
  op: DiffOp;
  /** The literal text of this span, including its trailing whitespace. */
  text: string;
}

/**
 * Tokenise into words *with* their trailing whitespace, so reassembling the
 * spans reproduces the original string exactly (whitespace is never lost).
 */
export function tokenize(text: string): string[] {
  if (text === '') return [];
  // Each token is a run of non-space followed by its trailing spaces, OR a
  // leading run of spaces. Matches the whole string with no gaps.
  return text.match(/\s+|\S+\s*/g) ?? [];
}

/**
 * Diff two strings at word granularity. The returned spans, concatenated,
 * reproduce `before` (via equal+delete) and `after` (via equal+insert).
 */
export function diffWords(before: string, after: string): DiffSpan[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const trace = lcsTable(a, b);
  return backtrack(a, b, trace);
}

/** Classic dynamic-programming LCS length table. */
function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const nextRow = table[i + 1]!;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  return table;
}

/** Walk the table to emit an ordered span list, coalescing runs of one op. */
function backtrack(a: string[], b: string[], table: Uint32Array[]): DiffSpan[] {
  const spans: DiffSpan[] = [];
  let i = 0;
  let j = 0;

  const push = (op: DiffOp, text: string): void => {
    const last = spans[spans.length - 1];
    if (last && last.op === op) last.text += text;
    else spans.push({ op, text });
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push('delete', a[i]!);
      i++;
    } else {
      push('insert', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('delete', a[i++]!);
  while (j < b.length) push('insert', b[j++]!);
  return spans;
}

/**
 * For each token in `a`, the index of the token in `b` it is matched to under
 * the LCS, or -1 if unmatched. Monotonic in both indices. This is the shared
 * alignment primitive the three-way merge builds on.
 */
export function matchIndices(a: string[], b: string[]): number[] {
  const table = lcsTable(a, b);
  const res = new Array<number>(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      res[i] = j;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return res;
}

/** Reassemble the "before" side from a span list. */
export function beforeText(spans: DiffSpan[]): string {
  return spans
    .filter((s) => s.op !== 'insert')
    .map((s) => s.text)
    .join('');
}

/** Reassemble the "after" side from a span list. */
export function afterText(spans: DiffSpan[]): string {
  return spans
    .filter((s) => s.op !== 'delete')
    .map((s) => s.text)
    .join('');
}

/** True when the two strings are identical (no insert/delete spans). */
export function isUnchanged(spans: DiffSpan[]): boolean {
  return spans.every((s) => s.op === 'equal');
}

/**
 * Character-level refinement of a changed region. Given the deleted and
 * inserted text of a replacement, diff them again at character granularity for
 * tighter highlighting. Optional polish over the word diff.
 */
export function refineToChars(deleted: string, inserted: string): DiffSpan[] {
  const a = [...deleted];
  const b = [...inserted];
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const spans: DiffSpan[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = spans[spans.length - 1];
    if (last && last.op === op) last.text += text;
    else spans.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push('delete', a[i]!);
      i++;
    } else {
      push('insert', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('delete', a[i++]!);
  while (j < b.length) push('insert', b[j++]!);
  return spans;
}
