/**
 * Real-time reconciler.
 *
 * Merges server pushes with local optimistic state, handling the guarantees the
 * brief spells out:
 *
 *   - at-least-once delivery: events are deduped by eventId through a bounded
 *     LRU, so duplicates are dropped and the set never grows without bound
 *     (the 500-note session must not leak);
 *   - no ordering guarantee: a replayed batch is applied in occurredAt order,
 *     and status is adopted from the server (source of truth) regardless;
 *   - event-before-ack: a version_added that echoes our own in-flight save is
 *     held until the save settles, so it can't be mistaken for a concurrent
 *     supersede;
 *   - supersede -> merge: if a server version lands while we have an in-flight
 *     optimistic edit, we emit a `supersede` effect that opens the same
 *     three-way merge as an autosave 409;
 *   - graceful interrupt: a server status change that invalidates what the user
 *     is doing is flagged, never silently dropped.
 *
 * It returns declarative effects; applying them to stores is the caller's job,
 * which keeps this module pure and unit-testable.
 */

import { RULES, applyServerTransition, isContentEditable, type Action } from '../domain/machine.js';
import type { Actor, NoteStatus, NoteSnapshot, Role } from '../domain/types.js';
import type { ServerEvent } from '../data/realtime.js';

export interface Viewer {
  id: string;
  role: Role;
}

export interface LocalView {
  actor: Actor;
  status: NoteStatus;
  assignedReviewerId: string | null;
  approvedAt: number | null;
  headVersionId: string;
  /** The user has a dirty or in-flight edit on this note. */
  editing: boolean;
  /** A save POST is currently outstanding (its resulting id not yet known). */
  saveInFlight: boolean;
}

export type ReconcileEffect =
  | { kind: 'duplicate' }
  | { kind: 'deferred' } // held until the in-flight save settles
  | { kind: 'presence'; noteId: string; viewers: Viewer[] }
  | {
      kind: 'status';
      noteId: string;
      fromStatus: NoteStatus;
      toStatus: NoteStatus;
      snapshot: NoteSnapshot | null;
      outcome: 'applied' | 'no-op' | 'violation';
      /** The change invalidates what the user was doing; surface, don't drop. */
      interrupt: boolean;
    }
  | { kind: 'version'; noteId: string; versionId: string; mode: 'fast-forward' | 'known' }
  | { kind: 'supersede'; noteId: string; serverVersionId: string };

/** Bounded set with LRU eviction — dedupe without unbounded growth. */
class LruSet {
  private readonly map = new Map<string, true>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.map.has(key);
  }
  add(key: string): void {
    if (this.map.has(key)) {
      this.map.delete(key); // refresh recency
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, true);
  }
  get size(): number {
    return this.map.size;
  }
}

/** Find the transition action that moves a note from -> to, for the machine. */
function inferAction(from: NoteStatus, to: NoteStatus): Action {
  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) return { type: 'start_review' }; // unreachable via legal pushes; machine will flag violation
  if (rule.action === 'reject') return { type: 'reject', reason: '(server)' };
  return { type: rule.action } as Action;
}

export class Reconciler {
  private readonly seen: LruSet;
  private readonly views = new Map<string, LocalView>();
  private readonly deferred = new Map<string, ServerEvent[]>();
  private readonly ownVersions = new Map<string, LruSet>();

  constructor(opts: { maxSeen?: number } = {}) {
    this.seen = new LruSet(opts.maxSeen ?? 2000);
  }

  /** Register or refresh a note's local view. Called by the stores. */
  setLocalView(noteId: string, view: LocalView): void {
    this.views.set(noteId, view);
  }

  removeLocalView(noteId: string): void {
    this.views.delete(noteId);
    this.deferred.delete(noteId);
    this.ownVersions.delete(noteId);
  }

  hasSeen(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** REST ack path: record a server eventId we already accounted for. */
  markSeen(eventId: string): void {
    this.seen.add(eventId);
  }

  get seenCount(): number {
    return this.seen.size;
  }

  /** Apply a batch (e.g. a reconnect replay) in occurredAt then seq order. */
  ingestBatch(events: ServerEvent[]): ReconcileEffect[] {
    return [...events]
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .map((e) => this.ingest(e));
  }

  ingest(event: ServerEvent): ReconcileEffect {
    if (this.seen.has(event.eventId)) return { kind: 'duplicate' };
    this.seen.add(event.eventId);

    switch (event.type) {
      case 'note.presence':
        return { kind: 'presence', noteId: event.noteId, viewers: event.viewers };
      case 'note.status_changed':
        return this.applyStatus(event);
      case 'note.version_added':
        return this.applyVersion(event);
    }
  }

  /**
   * The in-flight save for a note settled. Record the resulting version id as
   * "ours" (so its echo isn't a supersede) and replay any version events that
   * were deferred while the save was outstanding.
   */
  settleSave(noteId: string, newVersionId: string | null): ReconcileEffect[] {
    const view = this.views.get(noteId);
    if (view) view.saveInFlight = false;
    if (newVersionId) {
      let own = this.ownVersions.get(noteId);
      if (!own) {
        own = new LruSet(64);
        this.ownVersions.set(noteId, own);
      }
      own.add(newVersionId);
      if (view) view.headVersionId = newVersionId;
    }
    const held = this.deferred.get(noteId) ?? [];
    this.deferred.delete(noteId);
    return held.map((e) => this.applyVersion(e as Extract<ServerEvent, { type: 'note.version_added' }>));
  }

  // -- handlers -------------------------------------------------------------

  private applyStatus(event: Extract<ServerEvent, { type: 'note.status_changed' }>): ReconcileEffect {
    const view = this.views.get(event.noteId);
    if (!view) {
      // No local view (e.g. a list row not expanded): just report the status.
      return {
        kind: 'status',
        noteId: event.noteId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        snapshot: null,
        outcome: 'applied',
        interrupt: false,
      };
    }

    const snapshot: NoteSnapshot = {
      id: event.noteId,
      status: view.status,
      assignedReviewerId: view.assignedReviewerId,
      currentVersionId: view.headVersionId,
      approvedAt: view.approvedAt,
    };
    const result = applyServerTransition(
      snapshot,
      event.toStatus,
      inferAction(view.status, event.toStatus),
      view.actor,
      { now: event.at },
    );

    const interrupt = view.editing && !isContentEditable(result.note, view.actor);

    // Update the stored view so subsequent events reconcile against fresh state.
    view.status = result.note.status;
    view.assignedReviewerId = result.note.assignedReviewerId;
    view.approvedAt = result.note.approvedAt;

    return {
      kind: 'status',
      noteId: event.noteId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      snapshot: result.note,
      outcome: result.outcome,
      interrupt,
    };
  }

  private applyVersion(event: Extract<ServerEvent, { type: 'note.version_added' }>): ReconcileEffect {
    const noteId = event.noteId;
    const versionId = event.version.id;
    const view = this.views.get(noteId);

    // Already ours or already the head: nothing to do.
    if (view?.headVersionId === versionId || this.ownVersions.get(noteId)?.has(versionId)) {
      return { kind: 'version', noteId, versionId, mode: 'known' };
    }

    // A save is out and we don't yet know its id — hold this until it settles,
    // so our own echo can't be misread as a concurrent supersede.
    if (view?.saveInFlight) {
      const held = this.deferred.get(noteId) ?? [];
      held.push(event);
      this.deferred.set(noteId, held);
      return { kind: 'deferred' };
    }

    // No local edit in progress: fast-forward the head.
    if (!view || !view.editing) {
      if (view) view.headVersionId = versionId;
      return { kind: 'version', noteId, versionId, mode: 'fast-forward' };
    }

    // Editing locally and the head moved out from under us: needs a merge.
    return { kind: 'supersede', noteId, serverVersionId: versionId };
  }
}
