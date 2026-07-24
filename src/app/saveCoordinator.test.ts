import { describe, expect, it, vi } from 'vitest';
import { SaveCoordinator } from './saveCoordinator.js';
import { WriteQueue, type QueueState, type ReplayResult } from './writeQueue.js';
import { MemoryQueueStorage } from './queueStorage.js';
import { ConnectivityMonitor } from './connectivity.js';
import type { NotesApi } from './apiClient.js';
import type { SaveOutcome, SaveRequest } from './autosave.js';
import type { Actor, NoteContent } from '../domain/types.js';

const actor: Actor = { id: 'usr_a', role: 'REVIEWER', mfaVerifiedAt: 0 };
const content = (tag: string): NoteContent => ({ sections: { S: tag, O: '', A: '', P: '' } });

const req = (over: Partial<SaveRequest> = {}): SaveRequest => ({
  noteId: 'n1',
  baseVersionId: 'v1',
  content: content('edit'),
  clientMutationId: 'mut_1',
  attempt: 1,
  ...over,
});

const clock = () => {
  let t = 1_800_000_000_000;
  return () => (t += 1);
};

/** A NotesApi stub where only saveVersion matters here. */
const stubApi = (saveVersion: NotesApi['saveVersion']): NotesApi =>
  ({
    saveVersion,
    listNotes: vi.fn(),
    getNote: vi.fn(),
    replayWrite: vi.fn(),
    transition: vi.fn(),
  }) as unknown as NotesApi;

/** Controllable connectivity with an initial state and manual online/offline. */
const makeConnectivity = (online: boolean) => {
  let goOnline = () => {};
  let goOffline = () => {};
  const monitor = new ConnectivityMonitor({
    initialOnline: online,
    addEventListeners: (on, off) => {
      goOnline = on;
      goOffline = off;
      return () => {};
    },
  });
  return { monitor, goOnline: () => goOnline(), goOffline: () => goOffline() };
};

const setup = (opts: { online: boolean; saveVersion: NotesApi['saveVersion']; replaySave?: (e: { clientMutationId: string }) => Promise<ReplayResult> }) => {
  const { monitor, goOnline, goOffline } = makeConnectivity(opts.online);
  const queue = new WriteQueue({
    storage: new MemoryQueueStorage(),
    save: opts.replaySave ?? (async () => ({ status: 'saved', version: { id: 'v2', revision: 2 } })),
    now: clock(),
  });
  const conflicts: QueueState[] = [];
  const coordinator = new SaveCoordinator({
    api: stubApi(opts.saveVersion),
    queue,
    connectivity: monitor,
    getActor: () => actor,
    onReplayConflict: (s) => conflicts.push(s),
  });
  return { coordinator, queue, monitor, goOnline, goOffline, conflicts };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

describe('SaveCoordinator — online', () => {
  it('sends to the API and returns its outcome', async () => {
    const saveVersion = vi.fn(async (): Promise<SaveOutcome> => ({ status: 'saved', version: { id: 'v2', revision: 2 } }));
    const { coordinator, queue } = setup({ online: true, saveVersion });
    const outcome = await coordinator.save(req());
    expect(saveVersion).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ status: 'saved', version: { id: 'v2', revision: 2 } });
    expect(queue.depth).toBe(0); // nothing queued while online
  });

  it('passes a 409 conflict straight through', async () => {
    const saveVersion = async (): Promise<SaveOutcome> => ({
      status: 'conflict',
      current: { id: 'v9', revision: 7 },
      commonAncestor: { id: 'v4', revision: 4 },
    });
    const { coordinator } = setup({ online: true, saveVersion });
    const outcome = await coordinator.save(req());
    expect(outcome.status).toBe('conflict');
  });
});

describe('SaveCoordinator — offline', () => {
  it('queues the write and reports queued, without calling the API', async () => {
    const saveVersion = vi.fn();
    const { coordinator, queue } = setup({ online: false, saveVersion });
    const outcome = await coordinator.save(req());
    expect(outcome).toEqual({ status: 'queued' });
    expect(saveVersion).not.toHaveBeenCalled();
    expect(queue.depth).toBe(1);
  });

  it('coalesces successive offline edits into one queued write', async () => {
    const { coordinator, queue } = setup({ online: false, saveVersion: vi.fn() });
    await coordinator.save(req({ content: content('a'), clientMutationId: 'm1' }));
    await coordinator.save(req({ content: content('b'), clientMutationId: 'm2' }));
    await coordinator.save(req({ content: content('c'), clientMutationId: 'm3' }));
    expect(queue.depth).toBe(1); // one entry, latest content
    const entries = await queue.getState();
    expect(entries.depth).toBe(1);
  });

  it('re-throws a transport error while still reachable, for the engine to retry', async () => {
    const saveVersion = vi.fn(async () => {
      throw new Error('network blip');
    });
    const { coordinator, queue, monitor } = setup({ online: true, saveVersion });
    // A single failure must NOT strand the save in the queue — it stays a
    // retryable error and connectivity is merely flagged unstable (recoverable).
    await expect(coordinator.save(req())).rejects.toThrow();
    expect(queue.depth).toBe(0);
    expect(monitor.get()).toBe('unstable');
  });

  it('recovers to online after a later save succeeds', async () => {
    let calls = 0;
    const saveVersion = vi.fn(async (): Promise<SaveOutcome> => {
      calls += 1;
      if (calls === 1) throw new Error('blip');
      return { status: 'saved', version: { id: 'v2', revision: 2 } };
    });
    const { coordinator, monitor } = setup({ online: true, saveVersion });
    await expect(coordinator.save(req())).rejects.toThrow();
    expect(monitor.get()).toBe('unstable');
    const outcome = await coordinator.save(req({ clientMutationId: 'm2' }));
    expect(outcome.status).toBe('saved');
    expect(monitor.get()).toBe('online'); // reachable again, not stuck unstable
  });
});

describe('SaveCoordinator — reconnect replay', () => {
  it('replays the queue when connectivity returns to online', async () => {
    const applied: string[] = [];
    const replaySave = async (e: { clientMutationId: string }): Promise<ReplayResult> => {
      applied.push(e.clientMutationId);
      return { status: 'saved', version: { id: `v_${e.clientMutationId}`, revision: 2 } };
    };
    const { coordinator, goOffline, goOnline } = setup({ online: true, saveVersion: vi.fn(), replaySave });
    coordinator.start();

    goOffline();
    await coordinator.save(req({ clientMutationId: 'm1' }));

    goOnline(); // triggers replay
    await flush();
    await flush();
    expect(applied).toEqual(['m1']);
  });

  it('surfaces a replay conflict through onReplayConflict', async () => {
    const replaySave = async (): Promise<ReplayResult> => ({
      status: 'conflict',
      current: { id: 'v9', revision: 7 },
      commonAncestor: { id: 'v4', revision: 4 },
    });
    const { coordinator, goOffline, conflicts } = setup({ online: true, saveVersion: vi.fn(), replaySave });
    goOffline();
    await coordinator.save(req());
    const state = await coordinator.replay();
    expect(state.status).toBe('paused-conflict');
    expect(conflicts).toHaveLength(1);
  });
});
