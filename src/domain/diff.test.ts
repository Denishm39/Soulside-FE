import { describe, expect, it } from 'vitest';
import {
  afterText,
  beforeText,
  diffWords,
  isUnchanged,
  matchIndices,
  refineToChars,
  tokenize,
} from './diff.js';

const ops = (before: string, after: string) => diffWords(before, after).map((s) => `${s.op}:${s.text}`);

describe('tokenize', () => {
  it('keeps trailing whitespace so tokens reassemble losslessly', () => {
    const text = 'the quick  brown fox';
    expect(tokenize(text).join('')).toBe(text);
  });

  it('handles leading and trailing whitespace', () => {
    const text = '  hello world  ';
    expect(tokenize(text).join('')).toBe(text);
  });

  it('returns nothing for the empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('diffWords', () => {
  it('reports no changes for identical text', () => {
    const spans = diffWords('same text here', 'same text here');
    expect(isUnchanged(spans)).toBe(true);
  });

  it('detects a single inserted word', () => {
    expect(ops('the fox', 'the quick fox')).toContain('insert:quick ');
  });

  it('detects a single deleted word', () => {
    expect(ops('the quick fox', 'the fox')).toContain('delete:quick ');
  });

  it('reconstructs both sides exactly from the spans', () => {
    const before = 'Patient reports mild pain in the left knee.';
    const after = 'Patient reports moderate pain in the right knee today.';
    const spans = diffWords(before, after);
    expect(beforeText(spans)).toBe(before);
    expect(afterText(spans)).toBe(after);
  });

  it('is word-level, not character-level (whole tokens change)', () => {
    const spans = diffWords('cat', 'car');
    // "cat" -> "car" is a whole-word replace at word granularity
    expect(spans.some((s) => s.op === 'delete' && s.text.includes('cat'))).toBe(true);
    expect(spans.some((s) => s.op === 'insert' && s.text.includes('car'))).toBe(true);
  });

  it('coalesces adjacent same-op tokens into one span', () => {
    const spans = diffWords('a b c', 'a x y z c');
    // the inserted middle should be a single insert span, not three
    const inserts = spans.filter((s) => s.op === 'insert');
    expect(inserts.length).toBe(1);
  });

  it('handles full replacement', () => {
    const spans = diffWords('completely different', 'totally other words');
    expect(beforeText(spans)).toBe('completely different');
    expect(afterText(spans)).toBe('totally other words');
  });
});

describe('matchIndices', () => {
  it('aligns common tokens monotonically', () => {
    const a = tokenize('the quick brown fox');
    const b = tokenize('the slow brown fox');
    const m = matchIndices(a, b);
    // "the", "brown", "fox" match; "quick" (index 1) does not
    expect(m[0]).toBeGreaterThanOrEqual(0);
    expect(m[1]).toBe(-1);
    // matched indices strictly increase
    const matched = m.filter((x) => x !== -1);
    for (let i = 1; i < matched.length; i++) expect(matched[i]!).toBeGreaterThan(matched[i - 1]!);
  });
});

describe('refineToChars', () => {
  it('narrows a word replacement to the changed characters', () => {
    const spans = refineToChars('colour', 'color');
    expect(spans.filter((s) => s.op === 'delete').map((s) => s.text).join('')).toBe('u');
    // equal parts preserved
    expect(spans.filter((s) => s.op === 'equal').map((s) => s.text).join('')).toBe('color');
  });
});
