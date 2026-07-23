/**
 * Note lifecycle state machine.
 *
 * The single place where "is this allowed?" is answered. Pure: no clock, no
 * randomness, no I/O. `now` and `eventId` are injected by the caller so every
 * behaviour here is deterministic and unit-testable.
 *
 * Both user-initiated actions and server-pushed transitions run through this
 * module. See `applyServerTransition` for how authority is reconciled when the
 * two disagree.
 */

import type { Actor, NoteSnapshot, NoteStatus, ReviewEvent, Role } from './types.js';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'start_review' }
  | { type: 'return' }
  | { type: 'approve' }
  | { type: 'reject'; reason: string }
  | { type: 'resubmit' }
  | { type: 'amend' }
  | { type: 'regenerate' }
  | { type: 'generation_complete' }
  | { type: 'generation_error' }
  | { type: 'grace_expired' };

export type ActionType = Action['type'];

/**
 * Actions a user can invoke from the UI. The remaining action types are
 * system-only: they originate from the server and are never bound to a button.
 */
export const USER_ACTIONS = [
  'start_review',
  'return',
  'approve',
  'reject',
  'resubmit',
  'amend',
  'regenerate',
] as const satisfies readonly ActionType[];

export type UserActionType = (typeof USER_ACTIONS)[number];

const ACTION_LABELS: Record<ActionType, string> = {
  start_review: 'start a review',
  return: 'return',
  approve: 'approve',
  reject: 'reject',
  resubmit: 'resubmit',
  amend: 'amend',
  regenerate: 'regenerate',
  generation_complete: 'complete generation of',
  generation_error: 'fail generation of',
  grace_expired: 'lock',
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DenialCode =
  | 'WRONG_STATUS'
  | 'WRONG_ROLE'
  | 'NOT_ASSIGNED_REVIEWER'
  | 'REASON_REQUIRED'
  | 'MFA_REQUIRED'
  | 'GRACE_EXPIRED'
  | 'SYSTEM_ONLY'
  | 'READ_ONLY';

export interface Denial {
  allowed: false;
  code: DenialCode;
  /** Human-readable, shown verbatim in the disabled-button tooltip. */
  reason: string;
}

export type Decision = { allowed: true } | Denial;

const ALLOW: Decision = { allowed: true };

const deny = (code: DenialCode, reason: string): Denial => ({ allowed: false, code, reason });

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** How recently MFA must have been satisfied for an approval to count. */
export const MFA_FRESHNESS_MS = 5 * 60 * 1000;

export interface MachineEnv {
  /** Epoch ms. Injected, never read from the global clock. */
  now: number;
}

/**
 * Where the action came from. System-only transitions are rejected when they
 * arrive from a user, and role guards are not applied to server-driven
 * transitions (the server has already authorised the acting user).
 */
export type Origin = 'user' | 'server';

// ---------------------------------------------------------------------------
// Transition table — a direct transcription of the specification
// ---------------------------------------------------------------------------

interface GuardContext {
  note: NoteSnapshot;
  action: Action;
  actor: Actor;
  env: MachineEnv;
}

interface Rule {
  from: NoteStatus;
  to: NoteStatus;
  action: ActionType;
  /** Server-driven only; never invocable from the UI. */
  system: boolean;
  guard: (ctx: GuardContext) => Decision;
}

const noGuard = (): Decision => ALLOW;

const requireRole =
  (...allowed: Role[]) =>
  ({ actor }: GuardContext): Decision =>
    allowed.includes(actor.role)
      ? ALLOW
      : deny(
          'WRONG_ROLE',
          `Only ${formatRoles(allowed)} can perform this action. You are signed in as ${humanRole(actor.role)}.`,
        );

const requireAssignedReviewer = ({ note, actor }: GuardContext): Decision => {
  if (note.assignedReviewerId === null) {
    return deny('NOT_ASSIGNED_REVIEWER', 'This note has no assigned reviewer.');
  }
  if (note.assignedReviewerId !== actor.id) {
    return deny('NOT_ASSIGNED_REVIEWER', 'You are not the assigned reviewer for this note.');
  }
  return ALLOW;
};

const requireReason = ({ action }: GuardContext): Decision => {
  if (action.type !== 'reject') return ALLOW;
  return action.reason.trim().length > 0
    ? ALLOW
    : deny('REASON_REQUIRED', 'A reason is required to reject a note.');
};

const requireFreshMfa = ({ actor, env }: GuardContext): Decision => {
  if (actor.mfaVerifiedAt === null) {
    return deny('MFA_REQUIRED', 'Approving requires re-authentication.');
  }
  if (env.now - actor.mfaVerifiedAt > MFA_FRESHNESS_MS) {
    return deny('MFA_REQUIRED', 'Your re-authentication has expired. Verify again to approve.');
  }
  return ALLOW;
};

const requireWithinGrace = ({ note, env }: GuardContext): Decision => {
  if (note.approvedAt === null) {
    return deny('GRACE_EXPIRED', 'This note has no recorded approval time and cannot be amended.');
  }
  return env.now - note.approvedAt < GRACE_PERIOD_MS
    ? ALLOW
    : deny('GRACE_EXPIRED', 'The 24-hour amendment window has closed. This note is locked.');
};

const requireGraceExpired = ({ note, env }: GuardContext): Decision =>
  note.approvedAt !== null && env.now - note.approvedAt >= GRACE_PERIOD_MS
    ? ALLOW
    : deny('GRACE_EXPIRED', 'The 24-hour grace period has not yet elapsed.');

/** Runs guards left to right and returns the first denial. Order controls messaging. */
const all =
  (...guards: Array<(ctx: GuardContext) => Decision>) =>
  (ctx: GuardContext): Decision => {
    for (const guard of guards) {
      const decision = guard(ctx);
      if (!decision.allowed) return decision;
    }
    return ALLOW;
  };

export const RULES: readonly Rule[] = [
  {
    from: 'GENERATING',
    to: 'READY_FOR_REVIEW',
    action: 'generation_complete',
    system: true,
    guard: noGuard,
  },
  { from: 'GENERATING', to: 'FAILED', action: 'generation_error', system: true, guard: noGuard },
  {
    from: 'FAILED',
    to: 'GENERATING',
    action: 'regenerate',
    system: false,
    guard: requireRole('CLINICIAN', 'ADMIN'),
  },
  {
    from: 'READY_FOR_REVIEW',
    to: 'IN_REVIEW',
    action: 'start_review',
    system: false,
    guard: requireRole('REVIEWER'),
  },
  {
    from: 'IN_REVIEW',
    to: 'READY_FOR_REVIEW',
    action: 'return',
    system: false,
    guard: requireAssignedReviewer,
  },
  {
    from: 'IN_REVIEW',
    to: 'APPROVED',
    action: 'approve',
    system: false,
    guard: all(requireAssignedReviewer, requireFreshMfa),
  },
  {
    from: 'IN_REVIEW',
    to: 'REJECTED',
    action: 'reject',
    system: false,
    guard: all(requireAssignedReviewer, requireReason),
  },
  {
    from: 'REJECTED',
    to: 'READY_FOR_REVIEW',
    action: 'resubmit',
    system: false,
    guard: requireRole('CLINICIAN'),
  },
  {
    from: 'APPROVED',
    to: 'AMENDED',
    action: 'amend',
    system: false,
    // ASSUMPTION: the spec states no role guard for `amend`, only the grace
    // window. We restrict it to the authoring side; an auditor amending an
    // approved clinical note would be a compliance defect.
    guard: all(requireRole('CLINICIAN', 'ADMIN'), requireWithinGrace),
  },
  {
    from: 'APPROVED',
    to: 'LOCKED',
    action: 'grace_expired',
    system: true,
    guard: requireGraceExpired,
  },
  {
    from: 'AMENDED',
    to: 'IN_REVIEW',
    action: 'start_review',
    system: false,
    guard: requireRole('REVIEWER'),
  },
];

const findRule = (status: NoteStatus, action: ActionType): Rule | undefined =>
  RULES.find((rule) => rule.from === status && rule.action === action);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Can `actor` perform `action` on `note` right now?
 *
 * Never throws. A denial always carries a reason suitable for display, which is
 * what lets the UI render a disabled control that explains itself.
 */
export function can(
  note: NoteSnapshot,
  action: Action,
  actor: Actor,
  env: MachineEnv,
  origin: Origin = 'user',
): Decision {
  const rule = findRule(note.status, action.type);

  if (rule === undefined) {
    return deny(
      'WRONG_STATUS',
      `You cannot ${ACTION_LABELS[action.type]} a note that is ${humanStatus(note.status)}.`,
    );
  }

  if (origin === 'user') {
    if (rule.system) {
      return deny('SYSTEM_ONLY', 'This transition is applied by the server, not by a user.');
    }
    if (actor.role === 'READONLY_AUDITOR') {
      return deny('READ_ONLY', 'Your account has read-only access to the patient record.');
    }
  }

  return rule.guard({ note, action, actor, env });
}

export type TransitionResult =
  | { ok: true; note: NoteSnapshot; event: ReviewEvent }
  | { ok: false; denial: Denial };

export interface TransitionMeta {
  /** Caller-supplied so the machine stays pure. Locally minted ids are provisional. */
  eventId: string;
}

/**
 * Validate and apply a transition, producing the next snapshot plus the
 * ReviewEvent that records it. The input snapshot is never mutated.
 */
export function transition(
  note: NoteSnapshot,
  action: Action,
  actor: Actor,
  env: MachineEnv,
  meta: TransitionMeta,
  origin: Origin = 'user',
): TransitionResult {
  const decision = can(note, action, actor, env, origin);
  if (!decision.allowed) return { ok: false, denial: decision };

  // `can` returning allowed guarantees the rule exists.
  const rule = findRule(note.status, action.type) as Rule;

  const next: NoteSnapshot = {
    ...note,
    status: rule.to,
    assignedReviewerId: nextReviewer(note, action, actor),
    approvedAt: nextApprovedAt(note, rule.to, env),
  };

  const event: ReviewEvent = {
    eventId: meta.eventId,
    noteId: note.id,
    versionId: note.currentVersionId,
    fromStatus: note.status,
    toStatus: rule.to,
    actorId: actor.id,
    actorRole: actor.role,
    reason: action.type === 'reject' ? action.reason : null,
    occurredAt: env.now,
    pending: origin === 'user',
  };

  return { ok: true, note: next, event };
}

function nextReviewer(note: NoteSnapshot, action: Action, actor: Actor): string | null {
  switch (action.type) {
    case 'start_review':
      return actor.id;
    // The review episode is over; the lock is released.
    case 'return':
    case 'resubmit':
    case 'regenerate':
      return null;
    // `approve` and `reject` retain the reviewer: the record of who decided is
    // part of the note's workflow state, not just the audit log.
    default:
      return note.assignedReviewerId;
  }
}

function nextApprovedAt(note: NoteSnapshot, to: NoteStatus, env: MachineEnv): number | null {
  if (to === 'APPROVED') return env.now;
  // LOCKED must retain approvedAt so the audit trail keeps the approval time.
  if (to === 'LOCKED') return note.approvedAt;
  return null;
}

export interface AvailableAction {
  type: UserActionType;
  decision: Decision;
}

/**
 * Every user-invocable action with its decision, for rendering the action bar.
 * Components map over this; they never inspect `note.status` themselves.
 */
export function availableActions(
  note: NoteSnapshot,
  actor: Actor,
  env: MachineEnv,
): AvailableAction[] {
  return USER_ACTIONS.map((type) => ({
    type,
    // A representative payload: `reject` is probed without a reason so the bar
    // shows it as available-but-incomplete rather than hidden. The real reason
    // is collected by the dialog and validated on submit.
    decision: can(note, probeAction(type), actor, env),
  }));
}

function probeAction(type: UserActionType): Action {
  return type === 'reject' ? { type, reason: ' probe' } : { type };
}

/**
 * Is the note's content editable at all, ignoring who is asking?
 * LOCKED and terminal states are read-only presentations.
 */
export function isContentEditable(note: NoteSnapshot, actor: Actor): boolean {
  if (actor.role === 'READONLY_AUDITOR') return false;
  switch (note.status) {
    case 'IN_REVIEW':
      return note.assignedReviewerId === actor.id;
    case 'REJECTED':
      return actor.role === 'CLINICIAN' || actor.role === 'ADMIN';
    case 'AMENDED':
      return actor.role === 'CLINICIAN' || actor.role === 'ADMIN';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Server-driven transitions
// ---------------------------------------------------------------------------

export interface ServerTransitionResult {
  note: NoteSnapshot;
  /**
   * 'applied'   — the transition was legal under the machine.
   * 'no-op'     — the note was already in the target status (duplicate delivery).
   * 'violation' — the server moved the note somewhere the machine forbids. The
   *               server wins, but the caller must surface and report this
   *               rather than dropping it silently.
   */
  outcome: 'applied' | 'no-op' | 'violation';
}

/**
 * Apply an authoritative status change pushed by the server.
 *
 * The server is the source of truth, so the target status is always adopted.
 * Running it through the machine anyway tells us whether our client model had
 * drifted — a violation is a real signal (missed event, stale snapshot, bug)
 * and is reported, never swallowed.
 */
export function applyServerTransition(
  note: NoteSnapshot,
  toStatus: NoteStatus,
  action: Action,
  actor: Actor,
  env: MachineEnv,
): ServerTransitionResult {
  if (note.status === toStatus) {
    return { note, outcome: 'no-op' };
  }

  const result = transition(note, action, actor, env, { eventId: 'server' }, 'server');

  if (result.ok && result.note.status === toStatus) {
    return { note: result.note, outcome: 'applied' };
  }

  return {
    note: { ...note, status: toStatus, approvedAt: nextApprovedAt(note, toStatus, env) },
    outcome: 'violation',
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure string formatting)
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<NoteStatus, string> = {
  GENERATING: 'still generating',
  READY_FOR_REVIEW: 'ready for review',
  IN_REVIEW: 'in review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  AMENDED: 'amended',
  LOCKED: 'locked',
  FAILED: 'failed to generate',
};

const ROLE_LABELS: Record<Role, string> = {
  CLINICIAN: 'a clinician',
  REVIEWER: 'a reviewer',
  ADMIN: 'an admin',
  READONLY_AUDITOR: 'a read-only auditor',
};

export const humanStatus = (status: NoteStatus): string => STATUS_LABELS[status];
export const humanRole = (role: Role): string => ROLE_LABELS[role];

function formatRoles(roles: Role[]): string {
  const labels = roles.map(humanRole);
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1] as string}`;
}
