import { describe, expect, it } from 'vitest';
import { Reconciler, type LocalView } from './reconciler.js';
import { backoffDelay, DEFAULT_BACKOFF, ReconnectController, type Scheduler } from './reconnect.js';
import { SubscriptionManager } from './subscriptions.js';
import type { ServerEvent } from '../data/realtime.js';
import type { Actor } from '../domain/types.js';

const reviewer: Actor = { id: 'usr_chen', role: 'REVIEWER', mfaVerifiedAt: Date.now() };

let seq = 0;
const statusEvent = (over: Partial<Extract<ServerEvent, { type: 'note.status_changed' }>> = {}): ServerEvent => ({
  type: 'note.status_changed',
  seq: ++seq,
  eventId: `evt_${seq}`,
  noteId: 'note_1',
  fromStatus: 'READY_FOR_REVIEW',
  toStatus: 'IN_REVIEW',
  actor: { id: 'usr_other', displayName: 'Dr. Other' },
  at: 1000 + seq,
  ...over,
});

const versionEvent = (over: Partial<Extract<ServerEvent, { type: 'note.version_added' }>> = {}): ServerEvent => ({
  type: 'note.version_added',
  seq: ++seq,
  eventId: `evt_${seq}`,
  noteId: 'note_1',
  version: { id: 'ver_new', revision: 6 },
  at: 1000 + seq,
  ...over,
});

const view = (over: Partial<LocalView> = {}): LocalView => ({
  actor: reviewer,
  status: 'IN_REVIEW',
  assignedReviewerId: reviewer.id,
  approvedAt: null,
  headVersionId: 'ver_5',
  editing: false,
  saveInFlight: false,
  ...over,
});

// ---------------------------------------------------------------------------

describe('dedupe by eventId', () => {
  it('drops a duplicate delivery', () => {
    const r = new Reconciler();
    const e = statusEvent();
    expect(r.ingest(e).kind).not.toBe('duplicate');
    expect(r.ingest(e).kind).toBe('duplicate'); // same eventId again
  });

  it('bounds the seen set — old ids evict, no unbounded growth', () => {
    const r = new Reconciler({ maxSeen: 100 });
    for (let i = 0; i < 5000; i++) {
      r.ingest(statusEvent({ eventId: `e_${i}`, noteId: `n_${i}` }));
    }
    expect(r.seenCount).toBeLessThanOrEqual(100);
  });

  it('treats a REST ack (markSeen) and the WS echo as the same event', () => {
    const r = new Reconciler();
    r.markSeen('evt_shared');
    expect(r.ingest(statusEvent({ eventId: 'evt_shared' })).kind).toBe('duplicate');
  });
});

describe('status_changed adoption', () => {
  it('adopts a legal server status through the machine', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id }));
    const effect = r.ingest(statusEvent({ fromStatus: 'IN_REVIEW', toStatus: 'APPROVED' }));
    expect(effect.kind).toBe('status');
    if (effect.kind === 'status') {
      expect(effect.toStatus).toBe('APPROVED');
      expect(effect.snapshot?.status).toBe('APPROVED');
      expect(effect.outcome).toBe('applied');
    }
  });

  it('reports a status change for a note with no local view (a list row)', () => {
    const r = new Reconciler();
    const effect = r.ingest(statusEvent());
    expect(effect.kind).toBe('status');
    if (effect.kind === 'status') expect(effect.snapshot).toBeNull();
  });

  it('flags an interrupt when a server change invalidates the user\'s edit', () => {
    const r = new Reconciler();
    // I am editing while assigned; another actor's action moves it to APPROVED,
    // which I can no longer edit.
    r.setLocalView('note_1', view({ status: 'IN_REVIEW', assignedReviewerId: reviewer.id, editing: true }));
    const effect = r.ingest(statusEvent({ fromStatus: 'IN_REVIEW', toStatus: 'APPROVED' }));
    expect(effect.kind).toBe('status');
    if (effect.kind === 'status') expect(effect.interrupt).toBe(true);
  });

  it('does not flag an interrupt when not editing', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ status: 'IN_REVIEW', editing: false }));
    const effect = r.ingest(statusEvent({ fromStatus: 'IN_REVIEW', toStatus: 'APPROVED' }));
    if (effect.kind === 'status') expect(effect.interrupt).toBe(false);
  });
});

describe('version_added', () => {
  it('fast-forwards the head when not editing', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ editing: false, headVersionId: 'ver_5' }));
    const effect = r.ingest(versionEvent({ version: { id: 'ver_6', revision: 6 } }));
    expect(effect.kind).toBe('version');
    if (effect.kind === 'version') expect(effect.mode).toBe('fast-forward');
  });

  it('supersedes into a merge when a version lands mid-edit', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ editing: true, headVersionId: 'ver_5' }));
    const effect = r.ingest(versionEvent({ version: { id: 'ver_9', revision: 9 } }));
    expect(effect.kind).toBe('supersede');
    if (effect.kind === 'supersede') expect(effect.serverVersionId).toBe('ver_9');
  });

  it('treats a version we already have as known', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ headVersionId: 'ver_5' }));
    const effect = r.ingest(versionEvent({ version: { id: 'ver_5', revision: 5 } }));
    if (effect.kind === 'version') expect(effect.mode).toBe('known');
  });
});

describe('event-before-ack: our own save echo does not false-supersede', () => {
  it('defers a version_added while a save is in flight, then drops it on settle', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ editing: true, saveInFlight: true, headVersionId: 'ver_5' }));

    // The WS echo of our own save arrives before the REST ack.
    const echo = r.ingest(versionEvent({ version: { id: 'ver_6', revision: 6 } }));
    expect(echo.kind).toBe('deferred'); // held, not a supersede

    // The save settles with that same id -> the held echo is recognised as ours.
    const effects = r.settleSave('note_1', 'ver_6');
    expect(effects.every((e) => e.kind === 'version' && e.mode === 'known')).toBe(true);
  });

  it('still supersedes if the deferred version turns out to be someone else\'s', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ editing: true, saveInFlight: true, headVersionId: 'ver_5' }));
    r.ingest(versionEvent({ version: { id: 'ver_99', revision: 9 } })); // deferred

    // Our save settled as ver_6, but the deferred event was ver_99 (a colleague).
    const effects = r.settleSave('note_1', 'ver_6');
    expect(effects.some((e) => e.kind === 'supersede')).toBe(true);
  });
});

describe('ingestBatch orders by occurredAt (replay after reconnect)', () => {
  it('applies out-of-order events in time order', () => {
    const r = new Reconciler();
    r.setLocalView('note_1', view({ status: 'READY_FOR_REVIEW', assignedReviewerId: null, editing: false }));
    // Delivered out of order: APPROVED (t=200) before IN_REVIEW (t=100).
    const later = statusEvent({ eventId: 'later', fromStatus: 'IN_REVIEW', toStatus: 'APPROVED', at: 200 });
    const earlier = statusEvent({ eventId: 'earlier', fromStatus: 'READY_FOR_REVIEW', toStatus: 'IN_REVIEW', at: 100 });
    const effects = r.ingestBatch([later, earlier]);
    const statuses = effects.flatMap((e) => (e.kind === 'status' ? [e.toStatus] : []));
    expect(statuses).toEqual(['IN_REVIEW', 'APPROVED']); // applied in time order
  });
});

describe('presence', () => {
  it('passes viewers straight through', () => {
    const r = new Reconciler();
    const effect = r.ingest({
      type: 'note.presence',
      seq: ++seq,
      eventId: `evt_${seq}`,
      noteId: 'note_1',
      viewers: [{ id: 'usr_a', role: 'REVIEWER' }],
      at: 1,
    });
    expect(effect.kind).toBe('presence');
    if (effect.kind === 'presence') expect(effect.viewers[0]?.id).toBe('usr_a');
  });
});

// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('grows exponentially and respects the cap', () => {
    const opts = { initialMs: 500, capMs: 4000, jitter: 0 };
    expect(backoffDelay(1, opts, () => 0)).toBe(500);
    expect(backoffDelay(2, opts, () => 0)).toBe(1000);
    expect(backoffDelay(3, opts, () => 0)).toBe(2000);
    expect(backoffDelay(4, opts, () => 0)).toBe(4000);
    expect(backoffDelay(5, opts, () => 0)).toBe(4000); // capped
  });

  it('adds jitter within the expected band', () => {
    const opts = { initialMs: 1000, capMs: 60_000, jitter: 1 };
    expect(backoffDelay(1, opts, () => 0)).toBe(0); // all-random, rolled 0
    expect(backoffDelay(1, opts, () => 0.999)).toBe(999); // near the top of the band
  });

  it('default policy is bounded by the cap', () => {
    expect(backoffDelay(20, DEFAULT_BACKOFF, () => 1)).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs);
  });
});

describe('ReconnectController', () => {
  class ManualScheduler implements Scheduler {
    private h = 0;
    private readonly timers = new Map<number, () => void>();
    set(fn: () => void): unknown {
      const id = ++this.h;
      this.timers.set(id, fn);
      return id;
    }
    clear(h: unknown): void {
      this.timers.delete(h as number);
    }
    runAll(): void {
      for (const [id, fn] of [...this.timers]) {
        this.timers.delete(id);
        fn();
      }
    }
    get pending(): number {
      return this.timers.size;
    }
  }

  const flush = () => Promise.resolve();

  it('requests a replay from the cursor on successful connect', async () => {
    const scheduler = new ManualScheduler();
    const cursors: number[] = [];
    const ctrl = new ReconnectController({
      connect: async () => ({ ok: true }),
      onConnected: (c) => cursors.push(c),
      scheduler,
      random: () => 0,
    });
    ctrl.setCursor(42);
    ctrl.start();
    await flush();
    expect(cursors).toEqual([42]); // replay requested since last seen
    expect(ctrl.getState()).toBe('connected');
  });

  it('retries with backoff until it connects, resetting the attempt counter', async () => {
    const scheduler = new ManualScheduler();
    let attempts = 0;
    const ctrl = new ReconnectController({
      connect: async () => {
        attempts += 1;
        return attempts < 3 ? { ok: false } : { ok: true };
      },
      onConnected: () => {},
      scheduler,
      random: () => 0,
    });
    ctrl.start();
    await flush(); // attempt 1 fails -> schedule retry
    expect(ctrl.getState()).toBe('waiting');
    scheduler.runAll();
    await flush(); // attempt 2 fails
    scheduler.runAll();
    await flush(); // attempt 3 succeeds
    expect(attempts).toBe(3);
    expect(ctrl.getState()).toBe('connected');
    expect(ctrl.getAttempt()).toBe(0); // reset on success
  });

  it('stops cleanly and cancels any pending retry', async () => {
    const scheduler = new ManualScheduler();
    const ctrl = new ReconnectController({
      connect: async () => ({ ok: false }),
      onConnected: () => {},
      scheduler,
      random: () => 0,
    });
    ctrl.start();
    await flush();
    ctrl.stop();
    expect(scheduler.pending).toBe(0);
    expect(ctrl.getState()).toBe('waiting');
  });
});

// ---------------------------------------------------------------------------

describe('SubscriptionManager', () => {
  it('opens once and closes only when the last reference releases', () => {
    let open = 0;
    let close = 0;
    const mgr = new SubscriptionManager((_id) => {
      open += 1;
      return () => {
        close += 1;
      };
    });
    const a = mgr.acquire('note_1');
    const b = mgr.acquire('note_1'); // same note, second consumer
    expect(open).toBe(1); // opened once
    expect(mgr.openChannels).toBe(1);
    a();
    expect(close).toBe(0); // still one ref
    b();
    expect(close).toBe(1); // now closed
    expect(mgr.openChannels).toBe(0);
  });

  it('release is idempotent', () => {
    let close = 0;
    const mgr = new SubscriptionManager(() => () => {
      close += 1;
    });
    const release = mgr.acquire('n');
    release();
    release(); // second call must be a no-op
    expect(close).toBe(1);
  });

  it('setActive reconciles the live set to the viewport', () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const mgr = new SubscriptionManager((id) => {
      opened.push(id);
      return () => closed.push(id);
    });
    mgr.setActive(['a', 'b', 'c']);
    expect(mgr.openChannels).toBe(3);
    mgr.setActive(['b', 'c', 'd']); // 'a' left, 'd' entered
    expect(closed).toContain('a');
    expect(opened).toContain('d');
    expect(mgr.openChannels).toBe(3);
  });

  it('leaks nothing across a 500-note session', () => {
    let open = 0;
    let close = 0;
    const mgr = new SubscriptionManager(() => {
      open += 1;
      return () => {
        close += 1;
      };
    });
    // Scroll through 500 notes, 20 visible at a time.
    for (let i = 0; i < 500; i++) {
      const window: string[] = [];
      for (let k = 0; k < 20; k++) window.push(`note_${i + k}`);
      mgr.setActive(window);
    }
    mgr.setActive([]); // scroll away entirely
    expect(mgr.openChannels).toBe(0); // no leaked subscriptions
    expect(open).toBe(close); // every open was matched by a close
  });
});
