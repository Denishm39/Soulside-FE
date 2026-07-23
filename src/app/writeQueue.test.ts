import { describe, expect, it, vi } from 'vitest';
import { WriteQueue, type QueuedWrite, type ReplayResult, type ReplaySave } from './writeQueue.js';
import { MemoryQueueStorage } from './queueStorage.js';
import { ConnectivityMonitor, type Connectivity } from './connectivity.js';
import type { NoteContent } from '../domain/types.js';

const content = (tag: string): NoteContent => ({ sections: { S: tag, O: '', A: '', P: '' } });

// A monotonic clock so entry ids sort deterministically.
const clock = () => {
  let t = 1_800_000_000_000;
  return () => (t += 1);
};

const enqueueWrite = (noteId: string, base: string, tag: string, mut: string) => ({
  noteId,
  baseVersionId: base,
  content: content(tag),
  clientMutationId: mut,
});

const setup = (save: ReplaySave, storage = new MemoryQueueStorage()) => {
  const queue = new WriteQueue({ storage, save, now: clock() });
  return { queue, storage };
};

// ---------------------------------------------------------------------------

describe('enqueue and persistence', () => {
  it('persists before considering an entry enqueued', async () => {
    const storage = new MemoryQueueStorage();
    const { queue } = setup(async () => ({ status: 'saved', version: { id: 'v', revision: 2 } }), storage);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    expect((await storage.getAll()).length).toBe(1);
    expect(queue.depth).toBe(1);
  });

  it('survives a reload — a new queue over the same storage rehydrates entries', async () => {
    const storage = new MemoryQueueStorage();
    const save: ReplaySave = async () => ({ status: 'saved', version: { id: 'v', revision: 2 } });
    const first = new WriteQueue({ storage, save, now: clock() });
    await first.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    await first.enqueue(enqueueWrite('n1', 'v1', 'b', 'm2'));

    // Simulate a page reload: brand new queue instance, same storage.
    const reloaded = new WriteQueue({ storage, save, now: clock() });
    await reloaded.hydrate();
    expect(reloaded.depth).toBe(2);
  });
});

describe('ordered replay', () => {
  it('drains entries FIFO, one at a time', async () => {
    const seen: string[] = [];
    const save: ReplaySave = async (e) => {
      seen.push(e.clientMutationId);
      return { status: 'saved', version: { id: 'v', revision: 2 } };
    };
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'b', 'm2'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'c', 'm3'));

    await queue.replay();
    expect(seen).toEqual(['m1', 'm2', 'm3']);
    expect(queue.depth).toBe(0);
    expect(queue.getState().status).toBe('idle');
  });

  it('never overlaps two replay passes', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const save: ReplaySave = async (_e) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return { status: 'saved', version: { id: 'v', revision: 2 } };
    };
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'b', 'm2'));

    await Promise.all([queue.replay(), queue.replay()]); // overlapping calls
    expect(maxConcurrent).toBe(1);
  });

  it('reuses the same mutation id when an entry is replayed after a pause', async () => {
    const ids: string[] = [];
    let firstCall = true;
    const save: ReplaySave = async (e) => {
      ids.push(e.clientMutationId);
      if (firstCall) {
        firstCall = false;
        return { status: 'error', retryable: true, message: 'offline' };
      }
      return { status: 'saved', version: { id: 'v', revision: 2 } };
    };
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));

    await queue.replay(); // fails, pauses
    expect(queue.getState().status).toBe('paused-error');
    await queue.replay(); // reconnect: resumes the same entry
    expect(ids).toEqual(['m1', 'm1']); // idempotent — same key both times
    expect(queue.depth).toBe(0);
  });
});

describe('pause on transient error', () => {
  it('keeps the failed entry at the head and stops draining', async () => {
    const attempted: string[] = [];
    const save: ReplaySave = async (e) => {
      attempted.push(e.clientMutationId);
      return e.clientMutationId === 'm1'
        ? { status: 'error', retryable: true, message: 'network' }
        : { status: 'saved', version: { id: 'v', revision: 2 } };
    };
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'b', 'm2'));

    const state = await queue.replay();
    expect(state.status).toBe('paused-error');
    expect(attempted).toEqual(['m1']); // did NOT skip ahead to m2
    expect(queue.depth).toBe(2);
    expect(state.blocked?.entry.clientMutationId).toBe('m1');
  });
});

describe('conflict during replay', () => {
  it('pauses on a conflict, surfacing head + ancestor, without dropping the entry', async () => {
    const save: ReplaySave = async () => ({
      status: 'conflict',
      current: { id: 'ver_9', revision: 7 },
      commonAncestor: { id: 'ver_4', revision: 4 },
    });
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'mine', 'm1'));

    const state = await queue.replay();
    expect(state.status).toBe('paused-conflict');
    expect(state.blocked?.conflict?.current.id).toBe('ver_9');
    expect(state.blocked?.conflict?.commonAncestor?.id).toBe('ver_4');
    expect(queue.depth).toBe(1); // still there
  });

  it('resolveHead replaces the entry with merged content and resumes', async () => {
    const calls: QueuedWrite[] = [];
    let conflictOnce = true;
    const save: ReplaySave = async (e) => {
      calls.push(e);
      if (conflictOnce) {
        conflictOnce = false;
        return { status: 'conflict', current: { id: 'ver_9', revision: 7 }, commonAncestor: null };
      }
      return { status: 'saved', version: { id: 'ver_10', revision: 8 } };
    };
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'mine', 'm1'));

    await queue.replay();
    const state = await queue.resolveHead(content('merged'), 'ver_9');

    expect(state.status).toBe('idle');
    expect(queue.depth).toBe(0);
    expect(calls[1]!.content).toEqual(content('merged'));
    expect(calls[1]!.baseVersionId).toBe('ver_9'); // rebased on new head
    expect(calls[1]!.clientMutationId).not.toBe('m1'); // fresh key after human merge
  });

  it('resolveHead(null) discards the blocked entry', async () => {
    const save: ReplaySave = async () => ({
      status: 'conflict',
      current: { id: 'v', revision: 2 },
      commonAncestor: null,
    });
    const { queue } = setup(save);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'mine', 'm1'));
    await queue.replay();
    const state = await queue.resolveHead(null);
    expect(state.status).toBe('idle');
    expect(queue.depth).toBe(0);
  });
});

describe('the three-pending-writes / 20-minute-reconnect scenario', () => {
  it('holds three writes offline and replays them in order on reconnect', async () => {
    // Offline: saves always fail.
    let online = false;
    const seen: string[] = [];
    const save: ReplaySave = async (e): Promise<ReplayResult> => {
      if (!online) return { status: 'error', retryable: true, message: 'offline' };
      seen.push(e.clientMutationId);
      return { status: 'saved', version: { id: `ver_${e.clientMutationId}`, revision: 2 } };
    };
    const { queue } = setup(save);

    await queue.enqueue(enqueueWrite('n1', 'v1', 'edit1', 'm1'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'edit2', 'm2'));
    await queue.enqueue(enqueueWrite('n1', 'v1', 'edit3', 'm3'));

    const offlineState = await queue.replay();
    expect(offlineState.status).toBe('paused-error');
    expect(queue.depth).toBe(3); // nothing lost while offline

    // ...20 minutes later...
    online = true;
    const onlineState = await queue.replay();
    expect(onlineState.status).toBe('idle');
    expect(seen).toEqual(['m1', 'm2', 'm3']); // exact order preserved
    expect(queue.depth).toBe(0);
  });
});

describe('clear', () => {
  it('empties the queue and storage', async () => {
    const storage = new MemoryQueueStorage();
    const { queue } = setup(async () => ({ status: 'saved', version: { id: 'v', revision: 2 } }), storage);
    await queue.enqueue(enqueueWrite('n1', 'v1', 'a', 'm1'));
    await queue.clear();
    expect(queue.depth).toBe(0);
    expect((await storage.getAll()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('ConnectivityMonitor', () => {
  const fakeSources = () => {
    let onOnline = () => {};
    let onOffline = () => {};
    return {
      sources: {
        initialOnline: true,
        addEventListeners: (on: () => void, off: () => void) => {
          onOnline = on;
          onOffline = off;
          return () => {};
        },
      },
      goOnline: () => onOnline(),
      goOffline: () => onOffline(),
    };
  };

  it('starts from the injected initial state', () => {
    const monitor = new ConnectivityMonitor({ initialOnline: false, addEventListeners: () => () => {} });
    expect(monitor.get()).toBe('offline');
  });

  it('transitions on browser online/offline events', () => {
    const f = fakeSources();
    const monitor = new ConnectivityMonitor(f.sources);
    const seen: Connectivity[] = [];
    monitor.subscribe((s) => seen.push(s));
    f.goOffline();
    f.goOnline();
    expect(seen).toEqual(['online', 'offline', 'online']);
  });

  it('moves to unstable when the transport reports unreachable while OS says online', () => {
    const monitor = new ConnectivityMonitor({ initialOnline: true, addEventListeners: () => () => {} });
    monitor.reportUnreachable();
    expect(monitor.get()).toBe('unstable');
    monitor.reportReachable();
    expect(monitor.get()).toBe('online');
  });

  it('does not fire duplicate notifications for the same state', () => {
    const monitor = new ConnectivityMonitor({ initialOnline: true, addEventListeners: () => () => {} });
    const fn = vi.fn();
    monitor.subscribe(fn); // called once with initial
    monitor.reportReachable(); // already online -> no change
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
