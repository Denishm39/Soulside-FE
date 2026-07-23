import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VersionHistory } from './VersionHistory.js';
import type { NoteVersion } from '../../domain/types.js';

const version = (rev: number, parent: string | null, subjective: string): NoteVersion => ({
  versionId: `v${rev}`,
  noteId: 'n1',
  revisionNumber: rev,
  parentVersionId: parent,
  content: { sections: { S: subjective, O: '', A: '', P: '' } },
  authorId: 'usr_a',
  authorRole: 'REVIEWER',
  createdAt: 1_700_000_000_000 + rev * 1000,
});

const versions = [
  version(1, null, 'patient stable'),
  version(2, 'v1', 'patient very stable'),
];

describe('VersionHistory', () => {
  it('lists every version and marks the head', () => {
    render(<VersionHistory versions={versions} currentVersionId="v2" />);
    // "rev N" appears in both the list and the compare selects, so allow multiples.
    expect(screen.getAllByText('rev 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rev 2').length).toBeGreaterThan(0);
    expect(screen.getByText('head')).toBeTruthy();
  });

  it('diffs the head against its parent by default (word-level ins/del)', () => {
    const { container } = render(<VersionHistory versions={versions} currentVersionId="v2" />);
    // "stable" -> "very stable": the inserted word appears as an <ins>.
    const ins = container.querySelector('ins');
    expect(ins?.textContent).toContain('very');
  });

  it('is labelled for assistive tech', () => {
    render(<VersionHistory versions={versions} currentVersionId="v2" />);
    expect(screen.getByRole('complementary', { name: /version history/i })).toBeTruthy();
  });
});
