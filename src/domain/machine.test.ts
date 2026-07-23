import { describe, expect, it } from 'vitest';
import {
  GRACE_PERIOD_MS,
  MFA_FRESHNESS_MS,
  RULES,
  applyServerTransition,
  availableActions,
  can,
  isContentEditable,
  transition,
  type Action,
  type ActionType,
} from './machine.js';
import { NOTE_STATUSES, ROLES, type Actor, type NoteSnapshot, type Role } from './types.js';

const NOW = 1_700_000_000_000;
const env = { now: NOW };

const actor = (role: Role, id = `usr_${role}`, mfaVerifiedAt: number | null = NOW): Actor => ({
  id,
  role,
  mfaVerifiedAt,
});

const note = (over: Partial<NoteSnapshot> = {}): NoteSnapshot => ({
  id: 'note_1',
  status: 'READY_FOR_REVIEW',
  assignedReviewerId: null,
  currentVersionId: 'ver_1',
  approvedAt: null,
  ...over,
});

const meta = { eventId: 'evt_local_1' };

const reviewer = actor('REVIEWER', 'usr_reviewer');
const otherReviewer = actor('REVIEWER', 'usr_other');
const clinician = actor('CLINICIAN', 'usr_clinician');
const admin = actor('ADMIN', 'usr_admin');
const auditor = actor('READONLY_AUDITOR', 'usr_auditor');

// ---------------------------------------------------------------------------

describe('transition table completeness', () => {
  it('encodes exactly the eleven specified transitions', () => {
    expect(RULES).toHaveLength(11);
  });

  it('has no duplicate (from, action) pairs — one rule decides each case', () => {
    const keys = RULES.map((r) => `${r.from}:${r.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  const specified: Array<[string, ActionType, string]> = [
    ['GENERATING', 'generation_complete', 'READY_FOR_REVIEW'],
    ['GENERATING', 'generation_error', 'FAILED'],
    ['FAILED', 'regenerate', 'GENERATING'],
    ['READY_FOR_REVIEW', 'start_review', 'IN_REVIEW'],
    ['IN_REVIEW', 'return', 'READY_FOR_REVIEW'],
    ['IN_REVIEW', 'approve', 'APPROVED'],
    ['IN_REVIEW', 'reject', 'REJECTED'],
    ['REJECTED', 'resubmit', 'READY_FOR_REVIEW'],
    ['APPROVED', 'amend', 'AMENDED'],
    ['APPROVED', 'grace_expired', 'LOCKED'],
    ['AMENDED', 'start_review', 'IN_REVIEW'],
  ];

  it.each(specified)('%s --%s--> %s', (from, action, to) => {
    const rule = RULES.find((r) => r.from === from && r.action === action);
    expect(rule?.to).toBe(to);
  });
});

describe('unspecified (status, action) pairs are refused', () => {
  const allActions: ActionType[] = [
    'start_review',
    'return',
    'approve',
    'reject',
    'resubmit',
    'amend',
    'regenerate',
    'generation_complete',
    'generation_error',
    'grace_expired',
  ];

  it('denies every pair absent from the table with WRONG_STATUS', () => {
    const permitted = new Set(RULES.map((r) => `${r.from}:${r.action}`));
    let checked = 0;

    for (const status of NOTE_STATUSES) {
      for (const type of allActions) {
        if (permitted.has(`${status}:${type}`)) continue;
        checked += 1;
        const action = (type === 'reject' ? { type, reason: 'x' } : { type }) as Action;
        // Probed as ADMIN — the most privileged non-auditor role — so a denial
        // here is about the status, not about permissions.
        const decision = can(note({ status, assignedReviewerId: admin.id }), action, admin, env);
        expect(decision.allowed, `${status} + ${type} should be refused`).toBe(false);
        if (!decision.allowed) expect(decision.code).toBe('WRONG_STATUS');
      }
    }

    expect(checked).toBe(NOTE_STATUSES.length * allActions.length - RULES.length);
  });

  it('LOCKED accepts no action at all', () => {
    const locked = note({ status: 'LOCKED', approvedAt: NOW - GRACE_PERIOD_MS });
    for (const a of availableActions(locked, admin, env)) {
      expect(a.decision.allowed).toBe(false);
    }
  });
});

describe('start_review', () => {
  it('is allowed for a REVIEWER and assigns them', () => {
    const result = transition(note(), { type: 'start_review' }, reviewer, env, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('IN_REVIEW');
    expect(result.note.assignedReviewerId).toBe(reviewer.id);
  });

  it('is denied for a CLINICIAN with a role reason', () => {
    const decision = can(note(), { type: 'start_review' }, clinician, env);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe('WRONG_ROLE');
    expect(decision.reason).toMatch(/reviewer/i);
  });

  it('is denied for an ADMIN — the spec restricts it to REVIEWER', () => {
    expect(can(note(), { type: 'start_review' }, admin, env).allowed).toBe(false);
  });

  it('works the same way out of AMENDED', () => {
    const result = transition(
      note({ status: 'AMENDED' }),
      { type: 'start_review' },
      reviewer,
      env,
      meta,
    );
    expect(result.ok && result.note.status).toBe('IN_REVIEW');
  });
});

describe('approve', () => {
  const inReview = note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id });

  it('succeeds for the assigned reviewer with fresh MFA', () => {
    const result = transition(inReview, { type: 'approve' }, reviewer, env, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('APPROVED');
    expect(result.note.approvedAt).toBe(NOW);
  });

  it('is denied for a reviewer who is not the assignee', () => {
    const decision = can(inReview, { type: 'approve' }, otherReviewer, env);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe('NOT_ASSIGNED_REVIEWER');
    expect(decision.reason).toBe('You are not the assigned reviewer for this note.');
  });

  it('is denied without MFA', () => {
    const stale = actor('REVIEWER', reviewer.id, null);
    const decision = can(inReview, { type: 'approve' }, stale, env);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('MFA_REQUIRED');
  });

  it('is denied when MFA has gone stale, and allowed one ms inside the window', () => {
    const justExpired = actor('REVIEWER', reviewer.id, NOW - MFA_FRESHNESS_MS - 1);
    expect(can(inReview, { type: 'approve' }, justExpired, env).allowed).toBe(false);

    const justFresh = actor('REVIEWER', reviewer.id, NOW - MFA_FRESHNESS_MS);
    expect(can(inReview, { type: 'approve' }, justFresh, env).allowed).toBe(true);
  });

  it('checks assignment before MFA so the message is the more useful one', () => {
    const strangerNoMfa = actor('REVIEWER', 'usr_stranger', null);
    const decision = can(inReview, { type: 'approve' }, strangerNoMfa, env);
    if (!decision.allowed) expect(decision.code).toBe('NOT_ASSIGNED_REVIEWER');
  });
});

describe('reject', () => {
  const inReview = note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id });

  it('requires a non-empty reason', () => {
    const blank = can(inReview, { type: 'reject', reason: '   ' }, reviewer, env);
    expect(blank.allowed).toBe(false);
    if (!blank.allowed) expect(blank.code).toBe('REASON_REQUIRED');
  });

  it('records the reason on the emitted event', () => {
    const result = transition(
      inReview,
      { type: 'reject', reason: 'missing plan' },
      reviewer,
      env,
      meta,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('REJECTED');
    expect(result.event.reason).toBe('missing plan');
  });

  it('does not require MFA', () => {
    const noMfa = actor('REVIEWER', reviewer.id, null);
    expect(can(inReview, { type: 'reject', reason: 'thin' }, noMfa, env).allowed).toBe(true);
  });
});

describe('return releases the lock', () => {
  it('clears the assigned reviewer', () => {
    const result = transition(
      note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id }),
      { type: 'return' },
      reviewer,
      env,
      meta,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('READY_FOR_REVIEW');
    expect(result.note.assignedReviewerId).toBeNull();
  });
});

describe('resubmit', () => {
  const rejected = note({ status: 'REJECTED', assignedReviewerId: reviewer.id });

  it('is allowed for a CLINICIAN and clears the previous reviewer', () => {
    const result = transition(rejected, { type: 'resubmit' }, clinician, env, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('READY_FOR_REVIEW');
    expect(result.note.assignedReviewerId).toBeNull();
  });

  it('is denied for a REVIEWER', () => {
    expect(can(rejected, { type: 'resubmit' }, reviewer, env).allowed).toBe(false);
  });
});

describe('regenerate', () => {
  const failed = note({ status: 'FAILED' });

  it.each([
    ['CLINICIAN', true],
    ['ADMIN', true],
    ['REVIEWER', false],
    ['READONLY_AUDITOR', false],
  ] as const)('role %s -> %s', (role, expected) => {
    expect(can(failed, { type: 'regenerate' }, actor(role), env).allowed).toBe(expected);
  });
});

describe('the 24-hour grace window', () => {
  const approvedAt = NOW - 1000;
  const approved = note({ status: 'APPROVED', approvedAt });

  it('permits an amendment inside the window', () => {
    const result = transition(approved, { type: 'amend' }, clinician, env, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('AMENDED');
    expect(result.note.approvedAt).toBeNull();
  });

  it('refuses an amendment exactly at the boundary', () => {
    const boundary = { now: approvedAt + GRACE_PERIOD_MS };
    const decision = can(approved, { type: 'amend' }, clinician, boundary);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('GRACE_EXPIRED');
  });

  it('permits an amendment one ms before the boundary', () => {
    const boundary = { now: approvedAt + GRACE_PERIOD_MS - 1 };
    expect(can(approved, { type: 'amend' }, clinician, boundary).allowed).toBe(true);
  });

  it('refuses grace_expired before the window elapses', () => {
    const decision = can(approved, { type: 'grace_expired' }, clinician, env, 'server');
    expect(decision.allowed).toBe(false);
  });

  it('locks once the window has elapsed, preserving approvedAt for the audit trail', () => {
    const late = { now: approvedAt + GRACE_PERIOD_MS };
    const result = transition(approved, { type: 'grace_expired' }, clinician, late, meta, 'server');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('LOCKED');
    expect(result.note.approvedAt).toBe(approvedAt);
  });
});

describe('system-only transitions', () => {
  it.each(['generation_complete', 'generation_error'] as const)(
    '%s cannot be invoked by a user',
    (type) => {
      const decision = can(note({ status: 'GENERATING' }), { type }, admin, env);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('SYSTEM_ONLY');
    },
  );

  it('are permitted from the server', () => {
    const decision = can(
      note({ status: 'GENERATING' }),
      { type: 'generation_complete' },
      admin,
      env,
      'server',
    );
    expect(decision.allowed).toBe(true);
  });

  it('marks server-origin events as already acknowledged', () => {
    const result = transition(
      note({ status: 'GENERATING' }),
      { type: 'generation_complete' },
      admin,
      env,
      meta,
      'server',
    );
    expect(result.ok && result.event.pending).toBe(false);
  });

  it('marks user-origin events as pending until acknowledged', () => {
    const result = transition(note(), { type: 'start_review' }, reviewer, env, meta);
    expect(result.ok && result.event.pending).toBe(true);
  });
});

describe('READONLY_AUDITOR', () => {
  it('is denied every user action in every status', () => {
    for (const status of NOTE_STATUSES) {
      for (const a of availableActions(note({ status }), auditor, env)) {
        expect(a.decision.allowed, `${status}/${a.type}`).toBe(false);
      }
    }
  });

  it('can never edit content', () => {
    for (const status of NOTE_STATUSES) {
      expect(isContentEditable(note({ status }), auditor)).toBe(false);
    }
  });
});

describe('purity', () => {
  it('does not mutate the input snapshot', () => {
    const input = note();
    const snapshot = structuredClone(input);
    transition(input, { type: 'start_review' }, reviewer, env, meta);
    expect(input).toEqual(snapshot);
  });

  it('is deterministic — same inputs, same outputs', () => {
    const input = note();
    const a = transition(input, { type: 'start_review' }, reviewer, env, meta);
    const b = transition(input, { type: 'start_review' }, reviewer, env, meta);
    expect(a).toEqual(b);
  });

  it('derives its clock only from env', () => {
    const input = note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id });
    const later = transition(input, { type: 'approve' }, reviewer, { now: NOW + 50 }, meta);
    expect(later.ok && later.note.approvedAt).toBe(NOW + 50);
  });
});

describe('availableActions drives the action bar', () => {
  it('returns a decision for every user action, never throwing', () => {
    for (const status of NOTE_STATUSES) {
      for (const role of ROLES) {
        const actions = availableActions(note({ status }), actor(role), env);
        expect(actions).toHaveLength(7);
        for (const a of actions) expect(typeof a.decision.allowed).toBe('boolean');
      }
    }
  });

  it('every denial carries a non-empty, displayable reason', () => {
    for (const status of NOTE_STATUSES) {
      for (const role of ROLES) {
        for (const a of availableActions(note({ status }), actor(role), env)) {
          if (!a.decision.allowed) {
            expect(a.decision.reason.length).toBeGreaterThan(10);
            expect(a.decision.reason.endsWith('.')).toBe(true);
          }
        }
      }
    }
  });

  it('offers exactly start_review to a reviewer on a READY_FOR_REVIEW note', () => {
    const allowed = availableActions(note(), reviewer, env)
      .filter((a) => a.decision.allowed)
      .map((a) => a.type);
    expect(allowed).toEqual(['start_review']);
  });
});

describe('server-driven transitions', () => {
  const inReview = note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id });

  it('applies a legal push through the machine', () => {
    const result = applyServerTransition(inReview, 'APPROVED', { type: 'approve' }, reviewer, env);
    expect(result.outcome).toBe('applied');
    expect(result.note.status).toBe('APPROVED');
  });

  it('treats a duplicate delivery as a no-op (at-least-once safety)', () => {
    const approved = note({ status: 'APPROVED', approvedAt: NOW });
    const result = applyServerTransition(approved, 'APPROVED', { type: 'approve' }, reviewer, env);
    expect(result.outcome).toBe('no-op');
    expect(result.note).toBe(approved);
  });

  it('adopts an illegal server status but reports the violation', () => {
    // The client believed the note was READY_FOR_REVIEW; the server says LOCKED.
    // Our model had drifted — the server still wins.
    const result = applyServerTransition(note(), 'LOCKED', { type: 'grace_expired' }, admin, env);
    expect(result.outcome).toBe('violation');
    expect(result.note.status).toBe('LOCKED');
  });

  it('never silently drops a push it cannot explain', () => {
    const outcomes = NOTE_STATUSES.map(
      (status) =>
        applyServerTransition(note({ status }), 'REJECTED', { type: 'reject', reason: 'r' }, reviewer, env)
          .note.status,
    );
    expect(outcomes.every((s) => s === 'REJECTED')).toBe(true);
  });
});

describe('content editability', () => {
  it('is false for LOCKED regardless of role', () => {
    const locked = note({ status: 'LOCKED' });
    for (const role of ROLES) expect(isContentEditable(locked, actor(role))).toBe(false);
  });

  it('is true only for the assigned reviewer while IN_REVIEW', () => {
    const inReview = note({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id });
    expect(isContentEditable(inReview, reviewer)).toBe(true);
    expect(isContentEditable(inReview, otherReviewer)).toBe(false);
    expect(isContentEditable(inReview, clinician)).toBe(false);
  });
});
