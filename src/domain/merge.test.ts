import { describe, expect, it } from 'vitest';
import { mergeContent, mergeSection, resolveSection, type SectionMerge } from './merge.js';
import type { NoteContent } from './types.js';

const clean = (m: SectionMerge) => m.clean && m.merged;

describe('mergeSection — one-sided changes auto-merge', () => {
  it('takes mine when only I changed the section', () => {
    const m = mergeSection('S', 'the patient is stable', 'the patient is very stable', 'the patient is stable');
    expect(m.clean).toBe(true);
    expect(m.merged).toBe('the patient is very stable');
  });

  it('takes theirs when only they changed the section', () => {
    const m = mergeSection('S', 'the patient is stable', 'the patient is stable', 'the patient is now stable');
    expect(m.clean).toBe(true);
    expect(m.merged).toBe('the patient is now stable');
  });

  it('returns the original untouched text when neither side changed', () => {
    const text = 'no changes at all here';
    const m = mergeSection('S', text, text, text);
    expect(clean(m)).toBe(text);
  });

  it('takes the change when both sides made the identical edit', () => {
    const m = mergeSection('S', 'old wording', 'new wording', 'new wording');
    expect(m.clean).toBe(true);
    expect(m.merged).toBe('new wording');
  });
});

describe('mergeSection — non-overlapping changes both apply', () => {
  it('merges an edit at the start with an edit at the end', () => {
    const base = 'alpha beta gamma delta';
    const mine = 'ALPHA beta gamma delta'; // changed first word
    const theirs = 'alpha beta gamma DELTA'; // changed last word
    const m = mergeSection('S', base, mine, theirs);
    expect(m.clean).toBe(true);
    expect(m.merged).toBe('ALPHA beta gamma DELTA'); // both changes kept
  });
});

describe('mergeSection — genuine conflicts', () => {
  it('flags a conflict when both sides changed the same region differently', () => {
    const base = 'the plan is to increase the dose';
    const mine = 'the plan is to decrease the dose';
    const theirs = 'the plan is to maintain the dose';
    const m = mergeSection('A', base, mine, theirs);
    expect(m.clean).toBe(false);
    expect(m.merged).toBeNull();
    const conflict = m.chunks.find((c) => c.type === 'conflict');
    expect(conflict).toBeDefined();
    if (conflict?.type === 'conflict') {
      expect(conflict.mine).toContain('decrease');
      expect(conflict.theirs).toContain('maintain');
      expect(conflict.base).toContain('increase');
    }
  });

  it('isolates the conflict — stable text around it stays stable', () => {
    const base = 'intro CONFLICT outro';
    const mine = 'intro MINE outro';
    const theirs = 'intro THEIRS outro';
    const m = mergeSection('A', base, mine, theirs);
    const stable = m.chunks.filter((c) => c.type === 'stable').map((c) => (c.type === 'stable' ? c.text : ''));
    expect(stable.join('')).toContain('intro ');
    expect(stable.join('')).toContain('outro');
  });
});

describe('resolveSection', () => {
  const base = 'dose should be increased now';
  const mine = 'dose should be decreased now';
  const theirs = 'dose should be maintained now';

  it('applies a per-conflict choice and preserves stable text', () => {
    const m = mergeSection('A', base, mine, theirs);
    expect(resolveSection(m, ['mine'])).toBe('dose should be decreased now');
    expect(resolveSection(m, ['theirs'])).toBe('dose should be maintained now');
    expect(resolveSection(m, ['base'])).toBe('dose should be increased now');
  });

  it('defaults an unspecified choice to mine', () => {
    const m = mergeSection('A', base, mine, theirs);
    expect(resolveSection(m, [])).toBe('dose should be decreased now');
  });
});

describe('mergeContent across SOAP sections', () => {
  const content = (s: string, o: string, a: string, p: string): NoteContent => ({
    sections: { S: s, O: o, A: a, P: p },
  });

  it('is clean only when every section is clean', () => {
    const ancestor = content('s0', 'o0', 'a0', 'p0');
    const mine = content('s1', 'o0', 'a0', 'p0'); // only S changed
    const theirs = content('s0', 'o1', 'a0', 'p0'); // only O changed
    const result = mergeContent(ancestor, mine, theirs);
    expect(result.clean).toBe(true);
    expect(result.sections.find((x) => x.section === 'S')?.merged).toBe('s1');
    expect(result.sections.find((x) => x.section === 'O')?.merged).toBe('o1');
  });

  it('a conflict in one section does not disturb the others', () => {
    const ancestor = content('keep', 'the dose is 10mg', 'a0', 'p0');
    const mine = content('keep', 'the dose is 20mg', 'a0', 'p0'); // O conflict
    const theirs = content('keep', 'the dose is 30mg', 'a1', 'p0'); // O conflict + A one-sided
    const result = mergeContent(ancestor, mine, theirs);
    expect(result.clean).toBe(false);
    // S untouched, A auto-merged to theirs, only O is conflicted
    expect(result.sections.find((x) => x.section === 'S')?.clean).toBe(true);
    expect(result.sections.find((x) => x.section === 'A')?.merged).toBe('a1');
    expect(result.sections.find((x) => x.section === 'O')?.clean).toBe(false);
  });
});

describe('the two-reviewers scenario at the merge level', () => {
  it('lets the losing reviewer keep non-conflicting work and resolve the rest', () => {
    // Ancestor both branched from.
    const base = 'Assessment: patient improving. Plan: continue meds.';
    // Reviewer A (me): edited the assessment.
    const mine = 'Assessment: patient improving steadily. Plan: continue meds.';
    // Reviewer B (won the race): edited the plan.
    const theirs = 'Assessment: patient improving. Plan: continue meds and add physio.';

    const m = mergeSection('A', base, mine, theirs);
    // Different regions -> auto-merged, no data lost from either reviewer.
    expect(m.clean).toBe(true);
    expect(m.merged).toContain('improving steadily'); // my edit survived
    expect(m.merged).toContain('add physio'); // their edit survived
  });
});
