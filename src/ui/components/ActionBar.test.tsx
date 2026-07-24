import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionBar } from './ActionBar.js';
import type { Actor, NoteSnapshot } from '../../domain/types.js';

const NOW = 1_700_000_000_000;
const reviewer: Actor = { id: 'usr_chen', role: 'REVIEWER', mfaVerifiedAt: NOW };

const note = (over: Partial<NoteSnapshot> = {}): NoteSnapshot => ({
  id: 'n1',
  status: 'READY_FOR_REVIEW',
  assignedReviewerId: null,
  currentVersionId: 'v1',
  approvedAt: null,
  ...over,
});

describe('ActionBar', () => {
  it('renders enabled and disabled actions derived from the machine', () => {
    render(<ActionBar note={note()} actor={reviewer} now={NOW} onAction={() => {}} />);
    // A reviewer on a READY_FOR_REVIEW note can start a review...
    const start = screen.getByRole('button', { name: /Start review/ });
    expect(start.getAttribute('aria-disabled')).toBe('false');
    // ...but cannot approve yet — and it stays focusable so the reason is reachable.
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(approve.hasAttribute('disabled')).toBe(false); // NOT the disabled attribute
  });

  it('a disabled action does not fire onAction when clicked (guarded)', () => {
    const onAction = vi.fn();
    render(<ActionBar note={note()} actor={reviewer} now={NOW} onAction={onAction} />);
    screen.getByRole('button', { name: /Approve/ }).click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('exposes the denial reason on a disabled action', () => {
    render(<ActionBar note={note()} actor={reviewer} now={NOW} onAction={() => {}} />);
    const approve = screen.getByRole('button', { name: /Approve/ });
    // aria-label carries the machine's reason, so the disabled state explains itself.
    expect(approve.getAttribute('aria-label')).toMatch(/cannot approve/i);
  });

  it('fires onAction for an allowed action', () => {
    const onAction = vi.fn();
    render(<ActionBar note={note()} actor={reviewer} now={NOW} onAction={onAction} />);
    screen.getByRole('button', { name: /Start review/ }).click();
    expect(onAction).toHaveBeenCalledWith('start_review');
  });
});
