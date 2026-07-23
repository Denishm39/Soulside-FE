/**
 * Durable write queue.
 *
 * Writes made while offline (or while a save is failing) are appended here,
 * persisted, and replayed in order when connectivity returns. The brief's hard
 * requirements:
 *
 *   - survives a full page reload: the queue lives in a storage backend
 *     (IndexedDB in the browser), not just in memory;
 *   - ordered replay: entries drain FIFO, one at a time, honouring
 *     baseVersionId so a later edit never jumps ahead of an earlier one;
 *   - conflicts during replay use the same three-way merge path as live saves —
 *     replay pauses on a conflict and hands it to the caller, it does not drop
 *     the entry or overwrite;
 *   - idempotent: each entry carries its clientMutationId, so replaying an entry
 *     the server already received cannot create a duplicate.
 *
 * The storage backend is an interface so the queue is testable with an in-memory
 * fake and swappable for IndexedDB (see idbStore.ts) without touching this logic.
 */

import type { NoteContent } from '../domain/types.js';
import type { ConflictInfo, VersionRef } from './autosave.js';

export interface QueuedWrite {
  /** Stable id for this queue entry; also the ordering key (monotonic). */
  id: string;
  noteId: string;
  baseVersionId: string;
  content: NoteContent;
  /** Idempotency key — reused verbatim on every replay attempt. */
  clientMutationId: string;
  enqueuedAt: number;
}

/** Minimal persistence contract. IndexedDB and the test fake both satisfy it. */
export interface QueueStorage {
  getAll(): Promise<QueuedWrite[]>;
  put(entry: QueuedWrite): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export type ReplayResult =
  | { status: 'saved'; version: VersionRef }
  | ({ status: 'conflict' } & ConflictInfo)
  | { status: 'error'; retryable: boolean; message: string };

/** Sends one entry to the server. Supplied by the caller (wraps the API client). */
export type ReplaySave = (entry: QueuedWrite) => Promise<ReplayResult>;

export type QueueStatus = 'idle' | 'replaying' | 'paused-conflict' | 'paused-error';

export interface QueueState {
  status: QueueStatus;
  depth: number;
  /** The entry replay stopped on, when paused. */
  blocked: { entry: QueuedWrite; conflict: ConflictInfo | null; error: string | null } | null;
}

type Listener = (state: QueueState) => void;

let seq = 0;

export class WriteQueue {
  private readonly storage: QueueStorage;
  private readonly save: ReplaySave;
  private readonly now: () => number;

  /** In-memory mirror of the persisted queue, kept in FIFO order. */
  private entries: QueuedWrite[] = [];
  private status: QueueStatus = 'idle';
  private blocked: QueueState['blocked'] = null;
  private draining = false;
  private hydrated = false;

  private readonly listeners = new Set<Listener>();

  constructor(opts: { storage: QueueStorage; save: ReplaySave; now?: () => number }) {
    this.storage = opts.storage;
    this.save = opts.save;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load persisted entries after a reload. Must be called (and awaited) on boot
   * before replay so nothing queued in a previous session is lost.
   */
  async hydrate(): Promise<void> {
    const persisted = await this.storage.getAll();
    persisted.sort((a, b) => a.id.localeCompare(b.id));
    this.entries = persisted;
    this.hydrated = true;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  getState(): QueueState {
    return this.snapshot();
  }

  get depth(): number {
    return this.entries.length;
  }

  /** Append a write. Persisted before it is considered enqueued, so a crash
   *  immediately after cannot lose it. Ordering key is monotonic. */
  async enqueue(write: Omit<QueuedWrite, 'id' | 'enqueuedAt'>): Promise<QueuedWrite> {
    const entry: QueuedWrite = {
      ...write,
      id: this.nextId(),
      enqueuedAt: this.now(),
    };
    await this.storage.put(entry);
    this.entries.push(entry);
    this.emit();
    return entry;
  }

  /**
   * Drain the queue in order. Stops at the first conflict or non-retryable
   * error, leaving that entry and everything after it intact. Safe to call
   * repeatedly (e.g. on every reconnect); overlapping calls are coalesced.
   */
  async replay(): Promise<QueueState> {
    if (!this.hydrated) await this.hydrate();
    if (this.draining) return this.snapshot();
    this.draining = true;
    this.blocked = null;
    this.setStatus(this.entries.length > 0 ? 'replaying' : 'idle');

    try {
      while (this.entries.length > 0) {
        const entry = this.entries[0]!;
        const result = await this.save(entry);

        if (result.status === 'saved') {
          await this.remove(entry.id);
          continue;
        }
        if (result.status === 'conflict') {
          this.blocked = {
            entry,
            conflict: { current: result.current, commonAncestor: result.commonAncestor },
            error: null,
          };
          this.setStatus('paused-conflict');
          return this.snapshot();
        }
        // error
        if (result.retryable) {
          // Transient: stop draining but leave the entry at the head so the next
          // reconnect resumes exactly here. No reordering, no drop.
          this.blocked = { entry, conflict: null, error: result.message };
          this.setStatus('paused-error');
          return this.snapshot();
        }
        // Non-retryable: still do not silently drop. Surface for the caller to
        // decide (discard or turn into a conflict-style resolution).
        this.blocked = { entry, conflict: null, error: result.message };
        this.setStatus('paused-error');
        return this.snapshot();
      }
      this.setStatus('idle');
      return this.snapshot();
    } finally {
      this.draining = false;
    }
  }

  /**
   * Resolve the conflict/error the queue paused on. The head entry is replaced
   * with the merged content against the new base, then draining resumes.
   * Passing null content discards the blocked entry (explicit caller choice).
   */
  async resolveHead(
    mergedContent: NoteContent | null,
    newBaseVersionId?: string,
  ): Promise<QueueState> {
    const head = this.entries[0];
    if (!head || !this.blocked) return this.snapshot();

    if (mergedContent === null) {
      await this.remove(head.id);
    } else {
      const replacement: QueuedWrite = {
        ...head,
        content: mergedContent,
        baseVersionId: newBaseVersionId ?? head.baseVersionId,
        // New logical write after a human merge — new idempotency key so the
        // server treats it as distinct from the entry that conflicted.
        clientMutationId: `${head.clientMutationId}:merged:${this.nextId()}`,
      };
      await this.storage.put(replacement);
      this.entries[0] = replacement;
    }
    this.blocked = null;
    return this.replay();
  }

  /** Drop everything (e.g. user abandons offline work). */
  async clear(): Promise<void> {
    await this.storage.clear();
    this.entries = [];
    this.blocked = null;
    this.setStatus('idle');
  }

  // -- internals ------------------------------------------------------------

  private async remove(id: string): Promise<void> {
    await this.storage.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit();
  }

  private nextId(): string {
    // time-prefixed + counter: sorts chronologically and stays unique within a ms.
    return `${this.now().toString().padStart(15, '0')}_${(++seq).toString().padStart(6, '0')}`;
  }

  private setStatus(status: QueueStatus): void {
    this.status = status;
    this.emit();
  }

  private snapshot(): QueueState {
    return { status: this.status, depth: this.entries.length, blocked: this.blocked };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const fn of [...this.listeners]) fn(state);
  }
}
