import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConflictDialog } from './ConflictDialog.js';
import type { NoteContent } from '../../domain/types.js';

const content = (over: Partial<NoteContent['sections']>): NoteContent => ({
  sections: { S: '', O: '', A: '', P: '', ...over },
});

describe('ConflictDialog', () => {
  it('is a labelled modal dialog', () => {
    render(
      <ConflictDialog
        base={content({ A: 'increase the dose' })}
        mine={content({ A: 'decrease the dose' })}
        theirs={content({ A: 'maintain the dose' })}
        onResolve={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/Resolve conflicting edits/)).toBeTruthy();
  });

  it('builds the resolved content from the chosen side and returns it', () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        base={content({ A: 'increase the dose' })}
        mine={content({ A: 'decrease the dose' })}
        theirs={content({ A: 'maintain the dose' })}
        onResolve={onResolve}
        onCancel={() => {}}
      />,
    );
    // Default choice is "mine"; saving should yield my Assessment text.
    screen.getByRole('button', { name: /Save resolved version/ }).click();
    expect(onResolve).toHaveBeenCalledTimes(1);
    const merged = onResolve.mock.calls[0]![0] as NoteContent;
    expect(merged.sections.A).toContain('decrease');
  });

  it('auto-merges a section only one side changed, without a conflict choice', () => {
    render(
      <ConflictDialog
        base={content({ S: 'stable' })}
        mine={content({ S: 'very stable' })}
        theirs={content({ S: 'stable' })}
        onResolve={() => {}}
        onCancel={() => {}}
      />,
    );
    // The Subjective section shows as auto-merged (a badge), not a radio choice.
    expect(screen.getAllByText(/auto-merged/).length).toBeGreaterThan(0);
  });
});
