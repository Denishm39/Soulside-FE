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
import { WriteQueue } from './writeQueue.js';
import { createQueueStorage } from './queueStorage.js';

export interface Runtime {
  api: NotesApi;
  backend: MockBackend;
  reconciler: Reconciler;
  subscriptions: SubscriptionManager;
  connectivity: ConnectivityMonitor;
  telemetry: Telemetry;
  writeQueue: WriteQueue;
  /** The signed-in user. Swappable in the UI to demo role-based affordances. */
  getActor: () => Actor;
  setRole: (role: Role) => void;
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
  const subscriptions = new SubscriptionManager((noteId) =>
    backend.realtime.subscribe(noteId, () => {
      // Delivery is wired to stores in the UI layer; the manager only owns the
      // lifecycle here. A no-op keeps the channel open for ref-counting.
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

  return {
    api,
    backend,
    reconciler,
    subscriptions,
    connectivity,
    telemetry,
    writeQueue,
    getActor: () => actor,
    setRole: (role) => {
      actor = { ...actor, role, mfaVerifiedAt: Date.now() };
    },
  };
}
