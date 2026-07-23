/**
 * Authorization — a pure function of (role, status, ownership).
 *
 * The brief's stance is the important part: client-side checks are UX only, the
 * server is authoritative, and the abstraction must make it hard for a rogue
 * button click to bypass a guard. So every affordance resolves through this one
 * module, and a denial distinguishes "you may not" (permission) from "there is
 * nothing here" (missing data) — the two must never be shown the same way.
 *
 * This complements the state machine: the machine answers "is this transition
 * legal from this status?", authz answers "may this role, given ownership, do
 * this at all?". Route/component/action guards all read from here.
 */

import type { NoteStatus, Role } from './types.js';

export type Capability =
  | 'notes.list' // see the notes list at all
  | 'notes.read' // open a note's detail
  | 'notes.edit' // edit note content
  | 'notes.review' // start/return/approve/reject
  | 'notes.regenerate' // ask for AI regeneration
  | 'notes.amend' // amend within the grace window
  | 'notes.assignReviewer' // bulk-assign a reviewer
  | 'audit.read'; // read the review timeline / audit view

export type DenyReason = 'no-permission' | 'not-owner' | 'wrong-status' | 'read-only';

export interface AuthContext {
  role: Role;
  /** The acting user's id, for ownership checks. */
  userId: string;
  /** Present when the decision concerns a specific note. */
  note?: {
    status: NoteStatus;
    assignedReviewerId: string | null;
  };
}

export type AuthDecision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason; message: string };

const ALLOW: AuthDecision = { allowed: true };
const deny = (reason: DenyReason, message: string): AuthDecision => ({ allowed: false, reason, message });

/**
 * Coarse role capability matrix. Note-specific nuance (ownership, status) is
 * layered on top in `can`. READONLY_AUDITOR can see everything and change
 * nothing — the compliance persona.
 */
const ROLE_CAPS: Record<Role, ReadonlySet<Capability>> = {
  CLINICIAN: new Set(['notes.list', 'notes.read', 'notes.edit', 'notes.regenerate', 'notes.amend', 'audit.read']),
  REVIEWER: new Set(['notes.list', 'notes.read', 'notes.edit', 'notes.review', 'notes.assignReviewer', 'audit.read']),
  ADMIN: new Set([
    'notes.list',
    'notes.read',
    'notes.edit',
    'notes.review',
    'notes.regenerate',
    'notes.amend',
    'notes.assignReviewer',
    'audit.read',
  ]),
  READONLY_AUDITOR: new Set(['notes.list', 'notes.read', 'audit.read']),
};

/**
 * The single authorization decision. Pure, total, never throws. A denial always
 * carries a display message and a machine-readable reason so the UI can style
 * "no permission" differently from "no data".
 */
export function can(capability: Capability, ctx: AuthContext): AuthDecision {
  if (ctx.role === 'READONLY_AUDITOR' && isMutating(capability)) {
    return deny('read-only', 'Your account has read-only access to the patient record.');
  }

  if (!ROLE_CAPS[ctx.role].has(capability)) {
    return deny('no-permission', `Your role (${ctx.role}) does not permit this action.`);
  }

  // Note-scoped ownership rules.
  if (capability === 'notes.review' && ctx.note) {
    // Approving/returning/rejecting requires being the assigned reviewer once a
    // review is underway. Picking up a READY_FOR_REVIEW note is open to reviewers.
    if (ctx.note.status === 'IN_REVIEW' && ctx.note.assignedReviewerId !== ctx.userId) {
      return deny('not-owner', 'You are not the assigned reviewer for this note.');
    }
  }

  return ALLOW;
}

function isMutating(capability: Capability): boolean {
  return capability !== 'notes.list' && capability !== 'notes.read' && capability !== 'audit.read';
}

/** Convenience boolean for call sites that don't need the reason. */
export function allowed(capability: Capability, ctx: AuthContext): boolean {
  return can(capability, ctx).allowed;
}
