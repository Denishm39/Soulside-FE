/**
 * Mock backend facade.
 *
 * Wraps the synchronous Store in the messy realities the brief asks us to
 * simulate — network latency (100–800ms) and a ~5% failure rate — and wires
 * writes to the real-time channel so the rest of the app talks to something
 * that behaves like a flaky server. Everything ugly is toggleable so tests and
 * local dev can run clean.
 */

import type { Action } from '../domain/machine.js';
import type { Actor, NoteContent } from '../domain/types.js';
import { RealtimeChannel } from './realtime.js';
import { NotFoundError, Store, type ListParams, type ListResult, type NoteRecord, type SaveResult } from './store.js';

export interface FaultConfig {
  /** Enable latency + failure injection. Off => deterministic and instant. */
  enabled: boolean;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Probability a request fails with a 500-equivalent before touching the store. */
  failureRate: number;
}

export const DEFAULT_FAULTS: FaultConfig = {
  enabled: true,
  minLatencyMs: 100,
  maxLatencyMs: 800,
  failureRate: 0.05,
};

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface BackendOptions {
  seed?: number;
  count?: number;
  faults?: Partial<FaultConfig>;
  now?: () => number;
  /** Injected randomness so fault behaviour is reproducible under test. */
  random?: () => number;
  /** Injected delay; defaults to a real timer, replaced by fake timers in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class MockBackend {
  readonly store: Store;
  readonly realtime: RealtimeChannel;
  private readonly faults: FaultConfig;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: BackendOptions = {}) {
    this.store = new Store({
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.random = opts.random ?? Math.random;
    this.realtime = new RealtimeChannel({ random: this.random });
    this.faults = { ...DEFAULT_FAULTS, ...opts.faults };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // -- endpoints ------------------------------------------------------------

  /** GET /api/notes */
  async listNotes(params: ListParams = {}): Promise<ListResult> {
    await this.simulateNetwork();
    return this.store.list(params);
  }

  /** GET /api/notes/:id */
  async getNote(id: string): Promise<NoteRecord> {
    await this.simulateNetwork();
    const note = this.store.get(id);
    if (!note) throw new ServerError(`note ${id} not found`, 404);
    return note;
  }

  /** POST /api/notes/:id/versions */
  async saveVersion(
    id: string,
    body: { baseVersionId: string; content: NoteContent; clientMutationId: string },
    author: Actor,
  ): Promise<SaveResult> {
    await this.simulateNetwork();
    let result: SaveResult;
    try {
      result = this.store.createVersion(
        id,
        body.baseVersionId,
        body.content,
        author,
        body.clientMutationId,
      );
    } catch (e) {
      if (e instanceof NotFoundError) throw new ServerError(e.message, 404);
      throw e;
    }
    if (result.ok && !result.deduped) {
      this.realtime.emit({
        type: 'note.version_added',
        eventId: `evt_${result.version.versionId}`,
        noteId: id,
        version: { id: result.version.versionId, revision: result.version.revisionNumber },
        at: result.version.createdAt,
      });
    }
    return result;
  }

  /** POST /api/notes/:id/transitions */
  async postTransition(
    id: string,
    action: Action,
    actor: Actor,
  ): Promise<{ ok: true; eventId: string } | { ok: false; reason: string; status: number }> {
    await this.simulateNetwork();
    let result: ReturnType<Store['transition']>;
    try {
      result = this.store.transition(id, action, actor);
    } catch (e) {
      if (e instanceof NotFoundError) throw new ServerError(e.message, 404);
      throw e;
    }
    if (!result.ok) return { ok: false, reason: result.reason, status: 409 };

    this.realtime.emit({
      type: 'note.status_changed',
      eventId: result.event.eventId,
      noteId: id,
      fromStatus: result.event.fromStatus,
      toStatus: result.event.toStatus,
      actor: { id: actor.id, displayName: actor.id },
      at: result.event.occurredAt,
    });
    return { ok: true, eventId: result.event.eventId };
  }

  // -- fault injection ------------------------------------------------------

  private async simulateNetwork(): Promise<void> {
    if (!this.faults.enabled) return;
    const span = this.faults.maxLatencyMs - this.faults.minLatencyMs;
    const latency = this.faults.minLatencyMs + Math.floor(this.random() * (span + 1));
    await this.sleep(latency);
    if (this.random() < this.faults.failureRate) {
      throw new ServerError('injected upstream failure', 500);
    }
  }
}
