/**
 * Three-way merge (diff3) over note content.
 *
 * This is the logic behind the conflict UI required everywhere a save can lose
 * to a concurrent one: autosave 409, offline replay, and a real-time supersede
 * all resolve through here. Given the common ancestor, my version and the
 * server head, it:
 *
 *   - takes a change made on only one side automatically (no user prompt);
 *   - takes an identical change made on both sides automatically;
 *   - flags a true conflict only where both sides changed the same region to
 *     different things, presenting base / mine / theirs for the user to pick.
 *
 * It works per SOAP section, so a conflict in Assessment never forces the user
 * to re-resolve an untouched Plan — which is why sections are dirty-tracked
 * independently upstream.
 *
 * Pure and dependency-free, built on the word tokeniser + LCS in diff.ts.
 */

import { matchIndices, tokenize } from './diff.js';
import { SOAP_SECTIONS, type NoteContent, type SoapSection } from './types.js';

export type MergeChunk =
  | { type: 'stable'; text: string }
  | { type: 'conflict'; base: string; mine: string; theirs: string };

export interface SectionMerge {
  section: SoapSection;
  chunks: MergeChunk[];
  clean: boolean;
  /** The merged text when clean; null while any conflict is unresolved. */
  merged: string | null;
}

export interface ContentMerge {
  sections: SectionMerge[];
  /** True when every section merged without a conflict. */
  clean: boolean;
}

/**
 * Merge one section's three versions. `base` is the common ancestor.
 */
export function mergeSection(section: SoapSection, base: string, mine: string, theirs: string): SectionMerge {
  const o = tokenize(base);
  const a = tokenize(mine);
  const b = tokenize(theirs);

  const oa = matchIndices(o, a); // ancestor -> mine
  const ob = matchIndices(o, b); // ancestor -> theirs

  const chunks: MergeChunk[] = [];
  let oi = 0;
  let ai = 0;
  let bi = 0;
  /** Start of the ancestor region not yet flushed. */
  let lastO = 0;

  const pushStable = (text: string): void => {
    if (text === '') return;
    const last = chunks[chunks.length - 1];
    if (last && last.type === 'stable') last.text += text;
    else chunks.push({ type: 'stable', text });
  };

  const emitRegion = (oSlice: string[], aSlice: string[], bSlice: string[]): void => {
    const oText = oSlice.join('');
    const aText = aSlice.join('');
    const bText = bSlice.join('');
    if (aText === oText && bText === oText) {
      pushStable(oText);
    } else if (aText === oText) {
      pushStable(bText); // only theirs changed
    } else if (bText === oText) {
      pushStable(aText); // only mine changed
    } else if (aText === bText) {
      pushStable(aText); // both made the same change
    } else {
      chunks.push({ type: 'conflict', base: oText, mine: aText, theirs: bText });
    }
  };

  // Walk anchors: ancestor tokens matched in BOTH mine and theirs are the
  // stable synchronisation points. Regions between anchors are classified.
  for (oi = 0; oi <= o.length; oi++) {
    const isAnchor = oi < o.length && oa[oi] !== -1 && ob[oi] !== -1;
    const isEnd = oi === o.length;
    if (!isAnchor && !isEnd) continue;

    const aEnd = isEnd ? a.length : oa[oi]!;
    const bEnd = isEnd ? b.length : ob[oi]!;
    // startO tracked implicitly by the last flushed position; recompute slices.
    emitRegion(o.slice(lastO, oi), a.slice(ai, aEnd), b.slice(bi, bEnd));

    if (isAnchor) {
      pushStable(o[oi]!); // the anchor token: identical in all three
      ai = aEnd + 1;
      bi = bEnd + 1;
      lastO = oi + 1;
    }
  }

  const conflicted = chunks.some((c) => c.type === 'conflict');
  return {
    section,
    chunks,
    clean: !conflicted,
    merged: conflicted ? null : chunks.map((c) => (c.type === 'stable' ? c.text : '')).join(''),
  };
}

/**
 * Merge full note content across all SOAP sections.
 */
export function mergeContent(base: NoteContent, mine: NoteContent, theirs: NoteContent): ContentMerge {
  const sections = SOAP_SECTIONS.map((s) =>
    mergeSection(s, base.sections[s], mine.sections[s], theirs.sections[s]),
  );
  return { sections, clean: sections.every((s) => s.clean) };
}

export type Side = 'mine' | 'theirs' | 'base';

/**
 * Resolve a section given a choice for each of its conflict chunks (in order).
 * Stable chunks pass through; conflict chunks take the chosen side. Returns the
 * final section text.
 */
export function resolveSection(merge: SectionMerge, choices: Side[]): string {
  let ci = 0;
  return merge.chunks
    .map((chunk) => {
      if (chunk.type === 'stable') return chunk.text;
      const side = choices[ci++] ?? 'mine';
      return side === 'mine' ? chunk.mine : side === 'theirs' ? chunk.theirs : chunk.base;
    })
    .join('');
}
