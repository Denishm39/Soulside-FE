/**
 * Mock real-time channel.
 *
 * Models the guarantees the brief calls out, which are the interesting part:
 *   - at-least-once delivery: events can be duplicated or dropped;
 *   - no ordering guarantee across the wire;
 *   - a replay cursor so a client that reconnects can ask for everything since
 *     the last eventId it saw ("do not assume the socket dropped nothing").
 *
 * It is transport-agnostic: a thin WebSocket/SSE adapter can sit on top, but
 * the reconnect/replay semantics live here where they can be tested without a
 * socket.
 */

import type { NoteStatus, Role } from '../domain/types.js';

export type ServerEvent =
  | {
      type: 'note.status_changed';
      seq: number;
      eventId: string;
      noteId: string;
      fromStatus: NoteStatus;
      toStatus: NoteStatus;
      actor: { id: string; displayName: string };
      at: number;
    }
  | {
      type: 'note.version_added';
      seq: number;
      eventId: string;
      noteId: string;
      version: { id: string; revision: number };
      at: number;
    }
  | {
      type: 'note.presence';
      seq: number;
      eventId: string;
      noteId: string;
      viewers: Array<{ id: string; role: Role }>;
      at: number;
    };

export type Subscriber = (event: ServerEvent) => void;

/**
 * Omit that distributes over a union. Plain `Omit<Union, K>` collapses to only
 * the members' shared keys, which would erase the per-variant payload fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A server event without its seq — the caller supplies everything else. */
export type EmittableEvent = DistributiveOmit<ServerEvent, 'seq'>;

export interface EmitOptions {
  /** Probability the event is delivered twice (at-least-once duplication). */
  duplicateRate?: number;
  /** Probability the event is dropped from the live stream (recoverable via replay). */
  dropRate?: number;
}

export class RealtimeChannel {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** Bounded replay buffer keyed by monotonic seq. */
  private readonly log: ServerEvent[] = [];
  private seq = 0;
  private readonly maxLog: number;
  private readonly random: () => number;

  constructor(opts: { maxLog?: number; random?: () => number } = {}) {
    this.maxLog = opts.maxLog ?? 1000;
    this.random = opts.random ?? Math.random;
  }

  /** Subscribe to a single note's channel. Returns an unsubscribe function. */
  subscribe(noteId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(noteId);
    if (!set) {
      set = new Set();
      this.subscribers.set(noteId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subscribers.get(noteId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subscribers.delete(noteId);
    };
  }

  /**
   * Publish an event. Assigns the authoritative seq, records it for replay,
   * then delivers to live subscribers with optional drop/duplicate injection.
   */
  emit(event: EmittableEvent, opts: EmitOptions = {}): ServerEvent {
    const full = { ...event, seq: ++this.seq } as ServerEvent;
    this.log.push(full);
    if (this.log.length > this.maxLog) this.log.shift();

    const dropRate = opts.duplicateRate === undefined && opts.dropRate === undefined ? 0 : opts.dropRate ?? 0;
    const dupRate = opts.duplicateRate ?? 0;

    // The event is always in the replay log; drop only affects the live push.
    if (this.random() >= dropRate) {
      this.deliver(full);
      if (this.random() < dupRate) this.deliver(full);
    }
    return full;
  }

  private deliver(event: ServerEvent): void {
    const set = this.subscribers.get(event.noteId);
    if (!set) return;
    for (const fn of [...set]) fn(event);
  }

  /**
   * Replay every event after `sinceSeq` (0 for the full buffer). This is what a
   * reconnecting client calls so dropped live events are recovered. Returns
   * them in seq order; the caller still dedupes by eventId.
   */
  replaySince(sinceSeq: number): ServerEvent[] {
    return this.log.filter((e) => e.seq > sinceSeq);
  }

  /** Highest seq issued so far — the client stores this as its replay cursor. */
  get cursor(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }
}
