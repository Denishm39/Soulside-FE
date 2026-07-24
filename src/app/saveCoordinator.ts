/**
 * Save coordinator — the seam that routes every editor save to the right place.
 *
 *   online  → POST to the API, return its outcome (saved / conflict / error);
 *   offline → persist to the durable write queue and report `queued`.
 *
 * A network failure on an online attempt is treated as "we're actually offline":
 * the write falls through to the queue rather than being lost. On reconnect the
 * queue replays in order; a replay conflict is surfaced through the same
 * three-way merge as a live 409 (via the `onReplayConflict` hook).
 *
 * This is what makes offline a real application feature rather than a library
 * that only the tests exercise. The autosave engine calls `save`; connectivity
 * changes call `replay`. Both are injected, so this is unit-testable without a
 * browser.
 */

import type { Actor } from '../domain/types.js';
import type { NotesApi } from './apiClient.js';
import type { SaveFn, SaveOutcome, SaveRequest } from './autosave.js';
import type { ConnectivityMonitor } from './connectivity.js';
import type { QueuedWrite, QueueState, WriteQueue } from './writeQueue.js';

export interface SaveCoordinatorOptions {
  api: NotesApi;
  queue: WriteQueue;
  connectivity: ConnectivityMonitor;
  getActor: () => Actor;
  /** Called when queue replay pauses on a conflict, to open the merge UI. */
  onReplayConflict?: (state: QueueState) => void;
}

export class SaveCoordinator {
  private readonly api: NotesApi;
  private readonly queue: WriteQueue;
  private readonly connectivity: ConnectivityMonitor;
  private readonly getActor: () => Actor;
  private readonly onReplayConflict: ((state: QueueState) => void) | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: SaveCoordinatorOptions) {
    this.api = opts.api;
    this.queue = opts.queue;
    this.connectivity = opts.connectivity;
    this.getActor = opts.getActor;
    this.onReplayConflict = opts.onReplayConflict;
  }

  /** The save function handed to the autosave engine. */
  readonly save: SaveFn = async (req: SaveRequest): Promise<SaveOutcome> => {
    if (this.connectivity.isOnline()) {
      try {
        return await this.api.saveVersion(req, this.getActor());
      } catch {
        // The request failed at the transport level — treat as offline and
        // fall through to the queue so the edit is not lost.
        this.connectivity.reportUnreachable();
      }
    }
    await this.enqueue(req);
    return { status: 'queued' };
  };

  /** Begin watching connectivity: replay the queue whenever we come back online. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.connectivity.subscribe((state) => {
      if (state === 'online') void this.replay();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Drain the offline queue in order, surfacing any conflict for resolution. */
  async replay(): Promise<QueueState> {
    const state = await this.queue.replay();
    if (state.status === 'paused-conflict' && this.onReplayConflict) {
      this.onReplayConflict(state);
    }
    return state;
  }

  private enqueue(req: SaveRequest): Promise<QueuedWrite> {
    return this.queue.upsertForNote({
      noteId: req.noteId,
      baseVersionId: req.baseVersionId,
      content: req.content,
      clientMutationId: req.clientMutationId,
    });
  }
}
