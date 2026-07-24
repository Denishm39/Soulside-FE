/**
 * Application runtime — composition root.
 *
 * Constructs the mock backend and every effectful module once, wires them
 * together, and exposes them as a single object the React tree reads from a
 * context. This is the one place the concrete implementations are chosen; the
 * UI depends only on the interfaces, which is what would let the data layer or
 * transport be swapped without touching components.
 */

import { MockBackend } from '../data/backend.js';
import type { Actor, Role } from '../domain/types.js';
import { BackendApi, type NotesApi } from './apiClient.js';
import { Reconciler } from './reconciler.js';
import { SubscriptionManager } from './subscriptions.js';
import { ConnectivityMonitor } from './connectivity.js';
import { Telemetry } from './telemetry.js';
import { WriteQueue, type QueueState } from './writeQueue.js';
import { createQueueStorage } from './queueStorage.js';
import { SaveCoordinator } from './saveCoordinator.js';
import type { ServerEvent } from '../data/realtime.js';

export interface Runtime {
  api: NotesApi;
  backend: MockBackend;
  reconciler: Reconciler;
  subscriptions: SubscriptionManager;
  connectivity: ConnectivityMonitor;
  telemetry: Telemetry;
  writeQueue: WriteQueue;
  /** Routes saves online→API / offline→queue, and replays on reconnect. */
  saveCoordinator: SaveCoordinator;
  /** The signed-in user. Swappable in the UI to demo role-based affordances. */
  getActor: () => Actor;
  setRole: (role: Role) => void;
  /** Set by the UI to be notified when queue replay pauses on a conflict. */
  onReplayConflict: (handler: (state: QueueState) => void) => void;
  /**
   * Subscribe to real-time events for whichever notes are currently active
   * (opened via subscriptions.setActive). The list uses this to patch its cache
   * for visible rows. Returns an unsubscribe function.
   */
  onNoteEvent: (handler: (event: ServerEvent) => void) => () => void;
}

export interface RuntimeOptions {
  seed?: number;
  count?: number;
  cleanMode?: boolean; // disable latency/faults for a calmer demo
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const backend = new MockBackend({
    seed: opts.seed ?? 1,
    count: opts.count ?? 5000,
    ...(opts.cleanMode ? { faults: { enabled: false } } : {}),
  });
  const api = new BackendApi(backend);

  let actor: Actor = { id: 'usr_chen', role: 'REVIEWER', mfaVerifiedAt: Date.now() };

  const reconciler = new Reconciler();
  // Handlers registered by the UI (e.g. the list) that receive events for any
  // currently-active note channel. Kept here so the SubscriptionManager owns the
  // ref-counted lifecycle while delivery fans out to whoever is listening.
  const noteEventHandlers = new Set<(event: ServerEvent) => void>();
  const subscriptions = new SubscriptionManager((noteId) =>
    backend.realtime.subscribe(noteId, (event) => {
      for (const handler of [...noteEventHandlers]) handler(event);
    }),
  );
  const connectivity = new ConnectivityMonitor();
  const telemetry = new Telemetry({
    // In the mock, telemetry "sends" succeed instantly. A real sink would POST.
    sink: async () => ({ ok: true }),
  });
  const writeQueue = new WriteQueue({
    storage: createQueueStorage(),
    save: (entry) => api.replayWrite(entry, actor),
  });

  let replayConflictHandler: ((state: QueueState) => void) | null = null;
  const saveCoordinator = new SaveCoordinator({
    api,
    queue: writeQueue,
    connectivity,
    getActor: () => actor,
    onReplayConflict: (state) => replayConflictHandler?.(state),
  });
  saveCoordinator.start(); // replay the queue whenever connectivity returns

  return {
    api,
    backend,
    reconciler,
    subscriptions,
    connectivity,
    telemetry,
    writeQueue,
    saveCoordinator,
    getActor: () => actor,
    setRole: (role) => {
      actor = { ...actor, role, mfaVerifiedAt: Date.now() };
    },
    onReplayConflict: (handler) => {
      replayConflictHandler = handler;
    },
    onNoteEvent: (handler) => {
      noteEventHandlers.add(handler);
      return () => noteEventHandlers.delete(handler);
    },
  };
}
