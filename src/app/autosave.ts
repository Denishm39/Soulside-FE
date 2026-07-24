/**
 * Autosave engine.
 *
 * Owns the lifecycle of persisting a dirty draft while guaranteeing the
 * invariants the brief calls out:
 *
 *   - debounced: edits settle before a save fires;
 *   - single-flight: never two concurrent POSTs for the same note;
 *   - coalesced: while a save is in flight, at most one follow-up is queued and
 *     it always holds the latest content (newer edits replace older pending);
 *   - idempotent: a save keeps one clientMutationId across all its retries, so a
 *     retried POST the server already received cannot create a second version;
 *   - honest on conflict: a 409 stops the loop and surfaces head + ancestor for
 *     the merge UI — it never overwrites and never silently reloads.
 *
 * Framework-agnostic and clock-free: timers and id generation are injected, so
 * the whole thing is driven deterministically in tests with no real time.
 */

import { SOAP_SECTIONS, type NoteContent, type SoapSection } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Collaborators (injected)
// ---------------------------------------------------------------------------

export interface SaveRequest {
  noteId: string;
  baseVersionId: string;
  content: NoteContent;
  clientMutationId: string;
  /** 1 on the first attempt, incremented on each retry of the same mutation. */
  attempt: number;
}

export interface VersionRef {
  id: string;
  revision: number;
}

export interface ConflictInfo {
  /** The server's current head, which our base no longer matches. */
  current: VersionRef;
  /** Last version our base and the head share; the merge UI's third pane. */
  commonAncestor: VersionRef | null;
}

export type SaveOutcome =
  | { status: 'saved'; version: VersionRef }
  | ({ status: 'conflict' } & ConflictInfo)
  // The save was durably queued offline; it will sync on reconnect. The base
  // does not advance (all offline edits branch from the same version).
  | { status: 'queued' }
  | { status: 'error'; retryable: boolean; message: string };

export type SaveFn = (req: SaveRequest) => Promise<SaveOutcome>;

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

export type AutosaveStatus =
  | 'idle' // clean, everything saved
  | 'dirty' // unsaved edits, debounce running
  | 'saving' // a POST is in flight
  | 'retrying' // a POST failed, waiting to retry the same mutation
  | 'queued' // durably persisted offline, will sync on reconnect
  | 'conflict' // 409 — needs the user to resolve
  | 'error'; // non-retryable, or retries exhausted

export interface AutosaveState {
  status: AutosaveStatus;
  /** The version every new save branches from; advances as saves land. */
  baseVersionId: string;
  lastSavedVersionId: string | null;
  /** Edits exist that are not yet durably saved. */
  hasUnsavedChanges: boolean;
  /** Which SOAP sections differ from the last saved baseline (independently tracked). */
  dirtySections: Record<SoapSection, boolean>;
  conflict: ConflictInfo | null;
  error: string | null;
}

export interface AutosaveOptions {
  noteId: string;
  baseVersionId: string;
  save: SaveFn;
  /** The head content at mount, used as the baseline for per-section dirty tracking. */
  initialContent?: NoteContent;
  debounceMs?: number;
  maxRetries?: number;
  /** Backoff for retry N (1-based). Default: 200ms, 600ms, 1400ms... */
  backoffMs?: (attempt: number) => number;
  scheduler?: Scheduler;
  newMutationId?: () => string;
}

type Listener = (state: AutosaveState) => void;

let mutationCounter = 0;

export class AutosaveEngine {
  private readonly noteId: string;
  private readonly save: SaveFn;
  private readonly debounceMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly scheduler: Scheduler;
  private readonly newMutationId: () => string;

  private status: AutosaveStatus = 'idle';
  private baseVersionId: string;
  private lastSavedVersionId: string | null = null;
  private conflict: ConflictInfo | null = null;
  private error: string | null = null;

  /** Latest content the user has produced, saved or not. Source for the next save. */
  private draft: NoteContent | null = null;
  /** True when `draft` has edits not yet accepted by the server. */
  private dirty = false;
  /** Last durably-saved content; the baseline for per-section dirty comparison. */
  private baseline: NoteContent | null = null;

  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  /** The attempt currently in flight (saving or waiting to retry), if any. */
  private inFlight: SaveRequest | null = null;
  private disposed = false;

  private readonly listeners = new Set<Listener>();

  constructor(opts: AutosaveOptions) {
    this.noteId = opts.noteId;
    this.save = opts.save;
    this.baseVersionId = opts.baseVersionId;
    this.debounceMs = opts.debounceMs ?? 800;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? ((n) => 200 * (2 * n - 1));
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.newMutationId = opts.newMutationId ?? (() => `mut_${Date.now()}_${++mutationCounter}`);
    this.baseline = opts.initialContent ?? null;
  }

  // -- subscription ---------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  getState(): AutosaveState {
    return this.snapshot();
  }

  getDraft(): NoteContent | null {
    return this.draft;
  }

  // -- inputs ---------------------------------------------------------------

  /** The user edited the draft. Debounces a save. */
  change(content: NoteContent): void {
    if (this.disposed) return;
    this.draft = content;
    this.dirty = true;

    // While a save (or its retry) is in flight we do NOT open a second one; the
    // updated draft becomes the coalesced follow-up, saved once the current
    // attempt settles. Likewise in conflict, the user must resolve first.
    if (this.isInFlight() || this.status === 'conflict') {
      this.emit();
      return;
    }

    this.setStatus('dirty');
    this.armDebounce();
  }

  /** Force an immediate save, bypassing the debounce (e.g. on blur or navigate). */
  flush(): void {
    if (this.disposed) return;
    this.clearDebounce();
    if (!this.isInFlight() && this.dirty) this.beginSave();
  }

  /**
   * The head advanced from outside (a real-time version_added for a note we are
   * NOT mid-edit on). Safe only when we have nothing unsaved; otherwise the
   * reconciler must decide, so we ignore it here.
   */
  adoptServerVersion(versionId: string): void {
    if (this.disposed || this.isInFlight() || this.dirty) return;
    this.baseVersionId = versionId;
    this.lastSavedVersionId = versionId;
    this.emit();
  }

  /**
   * The merge UI resolved a conflict. Continue from the merged content against
   * the new head as a fresh save (new mutation id).
   */
  resolveConflict(mergedContent: NoteContent, newBaseVersionId: string): void {
    if (this.disposed) return;
    this.conflict = null;
    this.baseVersionId = newBaseVersionId;
    this.draft = mergedContent;
    this.dirty = true;
    this.beginSave();
  }

  /** Manually retry after landing in the error state. */
  retryNow(): void {
    if (this.disposed || this.status !== 'error' || !this.dirty) return;
    this.beginSave();
  }

  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    this.clearRetry();
    this.listeners.clear();
  }

  // -- internals ------------------------------------------------------------

  private isInFlight(): boolean {
    return this.status === 'saving' || this.status === 'retrying';
  }

  private armDebounce(): void {
    this.clearDebounce();
    this.debounceHandle = this.scheduler.set(() => {
      this.debounceHandle = null;
      if (!this.isInFlight() && this.dirty) this.beginSave();
    }, this.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceHandle !== null) {
      this.scheduler.clear(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      this.scheduler.clear(this.retryHandle);
      this.retryHandle = null;
    }
  }

  /** Promote the current draft into a new in-flight save. */
  private beginSave(): void {
    if (this.draft === null) return;
    this.clearDebounce();
    // A fresh logical save: new mutation id, snapshot the current draft. Edits
    // arriving after this point set dirty again and become the next save.
    this.inFlight = {
      noteId: this.noteId,
      baseVersionId: this.baseVersionId,
      content: this.draft,
      clientMutationId: this.newMutationId(),
      attempt: 1,
    };
    this.dirty = false;
    this.dispatch();
  }

  /** Send the in-flight request and react to the outcome. */
  private dispatch(): void {
    const req = this.inFlight;
    if (!req) return;
    this.setStatus(req.attempt === 1 ? 'saving' : 'retrying');

    this.save(req).then(
      (outcome) => this.onOutcome(req, outcome),
      (err: unknown) =>
        // A thrown/rejected save is treated as a retryable transport error.
        this.onOutcome(req, {
          status: 'error',
          retryable: true,
          message: err instanceof Error ? err.message : 'network error',
        }),
    );
  }

  private onOutcome(req: SaveRequest, outcome: SaveOutcome): void {
    if (this.disposed) return;
    // Guard against a late outcome from an attempt we already moved past.
    if (this.inFlight?.clientMutationId !== req.clientMutationId) return;

    switch (outcome.status) {
      case 'saved': {
        this.inFlight = null;
        this.error = null;
        this.baseVersionId = outcome.version.id;
        this.lastSavedVersionId = outcome.version.id;
        this.baseline = req.content; // this content is now durable
        // Edits landed during the save? Coalesced follow-up runs now.
        if (this.dirty) this.beginSave();
        else this.setStatus('idle');
        break;
      }
      case 'conflict': {
        this.inFlight = null;
        this.conflict = { current: outcome.current, commonAncestor: outcome.commonAncestor };
        // Keep the draft as "mine" so no work is lost; wait for resolveConflict.
        this.dirty = true;
        this.setStatus('conflict');
        break;
      }
      case 'queued': {
        // Durably persisted offline. The base does NOT advance — every offline
        // edit branches from the same version and coalesces into one queued
        // write, which replays on reconnect.
        this.inFlight = null;
        this.error = null;
        this.baseline = req.content; // durably persisted locally
        if (this.dirty) this.beginSave();
        else this.setStatus('queued');
        break;
      }
      case 'error': {
        if (outcome.retryable && req.attempt < this.maxRetries) {
          const next: SaveRequest = { ...req, attempt: req.attempt + 1 };
          this.inFlight = next; // same mutation id -> idempotent retry
          this.setStatus('retrying');
          this.clearRetry();
          this.retryHandle = this.scheduler.set(() => {
            this.retryHandle = null;
            this.dispatch();
          }, this.backoffMs(req.attempt));
        } else {
          this.inFlight = null;
          this.error = outcome.message;
          this.dirty = true; // nothing was saved; keep the draft for a manual retry
          this.setStatus('error');
        }
        break;
      }
    }
  }

  private setStatus(status: AutosaveStatus): void {
    this.status = status;
    this.emit();
  }

  private snapshot(): AutosaveState {
    return {
      status: this.status,
      baseVersionId: this.baseVersionId,
      lastSavedVersionId: this.lastSavedVersionId,
      hasUnsavedChanges: this.dirty || this.isInFlight(),
      dirtySections: this.computeDirtySections(),
      conflict: this.conflict,
      error: this.error,
    };
  }

  /** Per-section comparison of the current draft against the saved baseline. */
  private computeDirtySections(): Record<SoapSection, boolean> {
    const result = {} as Record<SoapSection, boolean>;
    for (const s of SOAP_SECTIONS) {
      result[s] =
        this.draft !== null &&
        this.baseline !== null &&
        this.draft.sections[s] !== this.baseline.sections[s];
    }
    return result;
  }

  private emit(): void {
    const state = this.snapshot();
    for (const fn of [...this.listeners]) fn(state);
  }
}
