/**
 * Domain types. Pure data — no imports, no I/O, no framework.
 */

export const NOTE_STATUSES = [
  'GENERATING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'AMENDED',
  'LOCKED',
  'FAILED',
] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const ROLES = ['CLINICIAN', 'REVIEWER', 'ADMIN', 'READONLY_AUDITOR'] as const;

export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string;
  role: Role;
  /** Epoch ms of the last successful MFA challenge, or null if never. */
  mfaVerifiedAt: number | null;
}

/**
 * The minimal projection of a Note the state machine needs.
 * Deliberately narrower than the wire type so the machine cannot depend
 * on presentation concerns.
 */
export interface NoteSnapshot {
  id: string;
  status: NoteStatus;
  assignedReviewerId: string | null;
  currentVersionId: string | null;
  /** Epoch ms the note entered APPROVED; null in every other status. */
  approvedAt: number | null;
}

export interface NoteVersion {
  versionId: string;
  noteId: string;
  revisionNumber: number;
  parentVersionId: string | null;
  content: NoteContent;
  authorId: string;
  authorRole: Role;
  createdAt: number;
}

export const SOAP_SECTIONS = ['S', 'O', 'A', 'P'] as const;
export type SoapSection = (typeof SOAP_SECTIONS)[number];

export interface NoteContent {
  sections: Record<SoapSection, string>;
}

export interface ReviewEvent {
  eventId: string;
  noteId: string;
  versionId: string | null;
  fromStatus: NoteStatus;
  toStatus: NoteStatus;
  actorId: string;
  actorRole: Role;
  reason: string | null;
  occurredAt: number;
  /**
   * True while this event exists only locally (optimistic). Reconciled to
   * false when the server acknowledges it with an authoritative eventId.
   */
  pending: boolean;
}
