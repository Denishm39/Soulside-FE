/**
 * In-memory authoritative store — the "server" behind the mock backend.
 *
 * This module is the source of truth in the simulation: it owns note status,
 * the version DAG, and the review-event log. It is pure data + synchronous
 * logic; latency, failure injection and the real-time channel are layered on
 * top in backend.ts so this stays trivially testable.
 */

import {
  applyServerTransition,
  transition as machineTransition,
  type Action,
} from '../domain/machine.js';
import type {
  Actor,
  NoteContent,
  NoteStatus,
  NoteVersion,
  ReviewEvent,
  Role,
  SoapSection,
} from '../domain/types.js';
import { SOAP_SECTIONS } from '../domain/types.js';
import { Rng } from './rng.js';
import { compareKeyset, decodeCursor, encodeCursor, isAfter, type Keyset } from './cursor.js';

// ---------------------------------------------------------------------------
// Server-side records (richer than the domain's minimal NoteSnapshot)
// ---------------------------------------------------------------------------

export interface Patient {
  id: string;
  displayName: string;
}

export interface NoteRecord {
  id: string;
  patient: Patient;
  status: NoteStatus;
  assignedReviewerId: string | null;
  currentVersionId: string;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  versions: NoteVersion[];
  events: ReviewEvent[];
}

export interface ListFilter {
  statuses?: NoteStatus[];
  assignedReviewerId?: string | null;
  patientQuery?: string;
  /** Server-side search across patient name and note content. */
  search?: string;
  updatedAfter?: number;
  updatedBefore?: number;
}

export type SortField = 'updatedAt' | 'createdAt' | 'status';
export type SortDir = 'asc' | 'desc';

export interface ListParams extends ListFilter {
  cursor?: string | null;
  limit?: number;
  /** Defaults to updatedAt desc — the canonical order used for the base index. */
  sortField?: SortField;
  sortDir?: SortDir;
}

export interface ListResult {
  items: NoteRecord[];
  cursor: { next: string | null; hasMore: boolean };
  meta: { total: number; returned: number; generatedAt: number };
}

export type SaveResult =
  | { ok: true; version: NoteVersion; deduped: boolean }
  | {
      ok: false;
      error: 'version_conflict';
      current: NoteVersion;
      commonAncestor: NoteVersion | null;
    };

// ---------------------------------------------------------------------------

const REVIEWERS = ['usr_chen', 'usr_patel', 'usr_okafor', 'usr_ramirez'] as const;

const PATIENT_NAMES = [
  'Riley A.',
  'Jordan B.',
  'Casey D.',
  'Morgan F.',
  'Taylor G.',
  'Avery H.',
  'Quinn K.',
  'Reese L.',
  'Sage M.',
  'Rowan P.',
] as const;

const SEED_STATUSES: NoteStatus[] = [
  'GENERATING',
  'READY_FOR_REVIEW',
  'READY_FOR_REVIEW',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'LOCKED',
  'FAILED',
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Ordering for a status sort — roughly lifecycle progression. */
const SORT_STATUS_RANK: Record<NoteStatus, number> = {
  GENERATING: 0,
  FAILED: 1,
  READY_FOR_REVIEW: 2,
  IN_REVIEW: 3,
  REJECTED: 4,
  AMENDED: 5,
  APPROVED: 6,
  LOCKED: 7,
};

export interface StoreOptions {
  seed?: number;
  count?: number;
  /** Injected clock. Defaults to Date.now; overridable for deterministic tests. */
  now?: () => number;
}

export class Store {
  private readonly notes = new Map<string, NoteRecord>();
  /** Maintained in list-sort order (updatedAt desc, id asc) for cursor paging. */
  private order: string[] = [];
  private readonly mutations = new Map<string, NoteVersion>();
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.seed(opts.seed ?? 1, opts.count ?? 5000);
  }

  // -- seeding --------------------------------------------------------------

  /** Deterministically populate the store. Same seed + count => identical state. */
  seed(seed: number, count: number): void {
    this.notes.clear();
    this.mutations.clear();
    this.order = [];
    const rng = new Rng(seed);
    const base = Date.UTC(2025, 10, 1);

    for (let i = 0; i < count; i++) {
      const status = SEED_STATUSES[i % SEED_STATUSES.length] as NoteStatus;
      const createdAt = base + rng.int(0, 30 * 24 * 60 * 60 * 1000);
      const updatedAt = createdAt + rng.int(0, 6 * 60 * 60 * 1000);
      const id = `note_${(i + 1).toString(36).padStart(5, '0')}`;
      const patient: Patient = {
        id: `pat_${rng.int(1000, 9999)}`,
        displayName: rng.pick(PATIENT_NAMES),
      };
      const revisions = rng.int(1, 4);
      const versions = this.buildVersionChain(id, revisions, createdAt, rng);
      const head = versions[versions.length - 1] as NoteVersion;
      const assigned =
        status === 'IN_REVIEW' || status === 'APPROVED' || status === 'REJECTED'
          ? rng.pick(REVIEWERS)
          : null;
      const approvedAt =
        status === 'APPROVED' || status === 'LOCKED' ? updatedAt - rng.int(0, 3600_000) : null;

      const record: NoteRecord = {
        id,
        patient,
        status,
        assignedReviewerId: assigned,
        currentVersionId: head.versionId,
        approvedAt,
        createdAt,
        updatedAt,
        versions,
        events: [],
      };
      this.notes.set(id, record);
    }

    this.order = [...this.notes.keys()].sort((a, b) =>
      compareKeyset(this.keyOf(a), this.keyOf(b)),
    );
  }

  private buildVersionChain(
    noteId: string,
    revisions: number,
    createdAt: number,
    rng: Rng,
  ): NoteVersion[] {
    const chain: NoteVersion[] = [];
    let parent: string | null = null;
    for (let r = 1; r <= revisions; r++) {
      const version: NoteVersion = {
        versionId: `ver_${noteId}_${r}`,
        noteId,
        revisionNumber: r,
        parentVersionId: parent,
        content: seededContent(rng, r),
        authorId: r === 1 ? 'ai_generator' : rng.pick(REVIEWERS),
        authorRole: r === 1 ? 'CLINICIAN' : 'REVIEWER',
        createdAt: createdAt + r * 1000,
      };
      chain.push(version);
      parent = version.versionId;
    }
    return chain;
  }

  private keyOf(id: string, field: SortField = 'updatedAt', dir: SortDir = 'desc'): Keyset {
    const note = this.notes.get(id);
    const raw = note ? this.sortValueOf(note, field) : 0;
    // compareKeyset orders by sortValue DESC; negating flips it to ascending,
    // so one comparator serves both directions and both cursor slicing paths.
    return { sortValue: dir === 'desc' ? raw : -raw, id };
  }

  private sortValueOf(note: NoteRecord, field: SortField): number {
    switch (field) {
      case 'createdAt':
        return note.createdAt;
      case 'status':
        return SORT_STATUS_RANK[note.status];
      case 'updatedAt':
      default:
        return note.updatedAt;
    }
  }

  // -- reads ----------------------------------------------------------------

  get(id: string): NoteRecord | null {
    return this.notes.get(id) ?? null;
  }

  list(params: ListParams = {}): ListResult {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const field = params.sortField ?? 'updatedAt';
    const dir = params.sortDir ?? 'desc';
    const isDefaultSort = field === 'updatedAt' && dir === 'desc';

    const matched: string[] = [];
    for (const id of this.order) {
      const note = this.notes.get(id);
      if (note && this.matches(note, params)) matched.push(id);
    }
    // `this.order` is already updatedAt-desc; re-sort only for a non-default sort.
    if (!isDefaultSort) {
      matched.sort((a, b) => compareKeyset(this.keyOf(a, field, dir), this.keyOf(b, field, dir)));
    }

    let startIndex = 0;
    if (cursor) {
      // Skip everything up to and including the cursor position. Because the
      // list is a total order and the cursor is a keyset, this never drops or
      // duplicates a row even if data shifted between requests.
      startIndex = matched.findIndex((id) => isAfter(cursor, this.keyOf(id, field, dir)));
      if (startIndex === -1) startIndex = matched.length;
    }

    const pageIds = matched.slice(startIndex, startIndex + limit);
    const items = pageIds.map((id) => this.notes.get(id) as NoteRecord);
    const hasMore = startIndex + limit < matched.length;
    const last = pageIds[pageIds.length - 1];

    return {
      items,
      cursor: {
        next: hasMore && last ? encodeCursor(this.keyOf(last, field, dir)) : null,
        hasMore,
      },
      meta: { total: matched.length, returned: items.length, generatedAt: this.now() },
    };
  }

  private matches(note: NoteRecord, f: ListFilter): boolean {
    if (f.statuses && f.statuses.length > 0 && !f.statuses.includes(note.status)) return false;
    if (f.assignedReviewerId !== undefined && note.assignedReviewerId !== f.assignedReviewerId) {
      return false;
    }
    if (f.updatedAfter !== undefined && note.updatedAt < f.updatedAfter) return false;
    if (f.updatedBefore !== undefined && note.updatedAt > f.updatedBefore) return false;
    if (f.patientQuery && !note.patient.displayName.toLowerCase().includes(f.patientQuery.toLowerCase())) {
      return false;
    }
    if (f.search) {
      const needle = f.search.toLowerCase();
      const inPatient = note.patient.displayName.toLowerCase().includes(needle);
      const head = note.versions.find((v) => v.versionId === note.currentVersionId);
      const inContent =
        head !== undefined &&
        SOAP_SECTIONS.some((s) => head.content.sections[s].toLowerCase().includes(needle));
      if (!inPatient && !inContent) return false;
    }
    return true;
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Append a new version. Rejects with version_conflict (the 409 path) when
   * baseVersionId is not the current head. Idempotent on clientMutationId:
   * a duplicate delivery returns the original version and creates nothing.
   */
  createVersion(
    noteId: string,
    baseVersionId: string,
    content: NoteContent,
    author: Actor,
    clientMutationId: string,
  ): SaveResult {
    const existing = this.mutations.get(clientMutationId);
    if (existing) return { ok: true, version: existing, deduped: true };

    const note = this.notes.get(noteId);
    if (!note) throw new NotFoundError(`note ${noteId}`);

    if (baseVersionId !== note.currentVersionId) {
      const current = note.versions.find((v) => v.versionId === note.currentVersionId);
      return {
        ok: false,
        error: 'version_conflict',
        current: current as NoteVersion,
        commonAncestor: this.lowestCommonAncestor(note, baseVersionId, note.currentVersionId),
      };
    }

    const head = note.versions.find((v) => v.versionId === note.currentVersionId) as NoteVersion;
    const version: NoteVersion = {
      versionId: `ver_${noteId}_${++this.seq}_${this.now()}`,
      noteId,
      revisionNumber: head.revisionNumber + 1,
      parentVersionId: head.versionId,
      content,
      authorId: author.id,
      authorRole: author.role,
      createdAt: this.now(),
    };

    note.versions.push(version);
    note.currentVersionId = version.versionId;
    this.touch(note);
    this.mutations.set(clientMutationId, version);
    return { ok: true, version, deduped: false };
  }

  /** Walk parent chains from both versions and return their deepest shared ancestor. */
  private lowestCommonAncestor(
    note: NoteRecord,
    aId: string,
    bId: string,
  ): NoteVersion | null {
    const byId = new Map(note.versions.map((v) => [v.versionId, v]));
    const ancestorsOfA = new Set<string>();
    let cur: string | null = aId;
    while (cur) {
      ancestorsOfA.add(cur);
      cur = byId.get(cur)?.parentVersionId ?? null;
    }
    cur = bId;
    while (cur) {
      if (ancestorsOfA.has(cur)) return byId.get(cur) ?? null;
      cur = byId.get(cur)?.parentVersionId ?? null;
    }
    return null;
  }

  /**
   * Apply a user-initiated status transition, validated through the domain
   * machine. Returns the emitted ReviewEvent or a denial reason.
   */
  transition(
    noteId: string,
    action: Action,
    actor: Actor,
  ): { ok: true; event: ReviewEvent } | { ok: false; reason: string } {
    const note = this.notes.get(noteId);
    if (!note) throw new NotFoundError(`note ${noteId}`);

    const result = machineTransition(
      this.snapshot(note),
      action,
      actor,
      { now: this.now() },
      { eventId: `evt_${++this.seq}_${this.now()}` },
    );
    if (!result.ok) return { ok: false, reason: result.denial.reason };

    note.status = result.note.status;
    note.assignedReviewerId = result.note.assignedReviewerId;
    note.approvedAt = result.note.approvedAt;
    const persisted: ReviewEvent = { ...result.event, pending: false };
    note.events.push(persisted);
    this.touch(note);
    return { ok: true, event: persisted };
  }

  /**
   * Apply an authoritative status change without user validation — used by the
   * simulator to drive server-side transitions. Goes through the same machine.
   */
  forceTransition(noteId: string, to: NoteStatus, action: Action, actor: Actor): ReviewEvent {
    const note = this.notes.get(noteId);
    if (!note) throw new NotFoundError(`note ${noteId}`);
    const { note: next } = applyServerTransition(
      this.snapshot(note),
      to,
      action,
      actor,
      { now: this.now() },
    );
    const event: ReviewEvent = {
      eventId: `evt_${++this.seq}_${this.now()}`,
      noteId,
      versionId: note.currentVersionId,
      fromStatus: note.status,
      toStatus: to,
      actorId: actor.id,
      actorRole: actor.role,
      reason: null,
      occurredAt: this.now(),
      pending: false,
    };
    note.status = next.status;
    note.assignedReviewerId = next.assignedReviewerId;
    note.approvedAt = next.approvedAt;
    note.events.push(event);
    this.touch(note);
    return event;
  }

  private snapshot(note: NoteRecord) {
    return {
      id: note.id,
      status: note.status,
      assignedReviewerId: note.assignedReviewerId,
      currentVersionId: note.currentVersionId,
      approvedAt: note.approvedAt,
    };
  }

  /** Bump updatedAt and re-position the note at the front of the sort order. */
  private touch(note: NoteRecord): void {
    note.updatedAt = this.now();
    const idx = this.order.indexOf(note.id);
    if (idx !== -1) this.order.splice(idx, 1);
    // Newest updatedAt sorts first; find insertion point by keyset order.
    const key = this.keyOf(note.id);
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeyset(this.keyOf(this.order[mid] as string), key) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.order.splice(lo, 0, note.id);
  }

  get size(): number {
    return this.notes.size;
  }
}

export class NotFoundError extends Error {}

function seededContent(rng: Rng, revision: number): NoteContent {
  const sections = {} as Record<SoapSection, string>;
  for (const s of SOAP_SECTIONS) {
    sections[s] = `${SECTION_STUBS[s]} (rev ${revision}, ${rng.int(100, 999)})`;
  }
  return { sections };
}

const SECTION_STUBS: Record<SoapSection, string> = {
  S: 'Patient reports intermittent symptoms.',
  O: 'Vitals within normal range.',
  A: 'Assessment pending further review.',
  P: 'Continue current plan, follow up in two weeks.',
};
