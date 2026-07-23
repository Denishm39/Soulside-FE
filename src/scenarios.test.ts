/**
 * The five scenarios the brief asks us to prove, as first-class integration
 * tests that wire the real modules together (store, autosave engine, write
 * queue, reconciler, subscription manager, three-way merge) rather than mocking
 * the interesting parts away.
 *
 * Each `describe` is named to match the brief so a reviewer can check them off.
 */

import { describe, expect, it } from 'vitest';
import { Store } from './data/store.js';
import { AutosaveEngine, type SaveFn, type SaveOutcome } from './app/autosave.js';
import { WriteQueue, type ReplayResult } from './app/writeQueue.js';
import { MemoryQueueStorage } from './app/queueStorage.js';
import { ConnectivityMonitor } from './app/connectivity.js';
import { Reconciler, type LocalView } from './app/reconciler.js';
import { SubscriptionManager } from './app/subscriptions.js';
import { mergeContent } from './domain/merge.js';
import type { ServerEvent } from './data/realtime.js';
import type { Actor, NoteContent } from './domain/types.js';

const clock = () => {
  let t = Date.UTC(2027, 0, 1);
  return () => (t += 1000);
};

const reviewer = (id: string): Actor => ({ id, role: 'REVIEWER', mfaVerifiedAt: Date.UTC(2027, 0, 1) });
const clinician = (id: string): Actor => ({ id, role: 'CLINICIAN', mfaVerifiedAt: Date.UTC(2027, 0, 1) });
const admin = (id: string): Actor => ({ id, role: 'ADMIN', mfaVerifiedAt: Date.UTC(2027, 0, 1) });

/** Map the store's save result into the SaveOutcome the autosave engine expects. */
const saveVia = (store: Store, actor: Actor): SaveFn => async (req): Promise<SaveOutcome> => {
  const r = store.createVersion(req.noteId, req.baseVersionId, req.content, actor, req.clientMutationId);
  if (r.ok) return { status: 'saved', version: { id: r.version.versionId, revision: r.version.revisionNumber } };
  return {
    status: 'conflict',
    current: { id: r.current.versionId, revision: r.current.revisionNumber },
    commonAncestor: r.commonAncestor
      ? { id: r.commonAncestor.versionId, revision: r.commonAncestor.revisionNumber }
      : null,
  };
};

const contentOf = (store: Store, noteId: string, versionId: string): NoteContent =>
  store.get(noteId)!.versions.find((v) => v.versionId === versionId)!.content;

const soap = (over: Partial<NoteContent['sections']>): NoteContent => ({
  sections: { S: '', O: '', A: '', P: '', ...over },
});

/** Let queued microtasks + the immediate macrotask settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ===========================================================================

describe('Scenario 1: two reviewers edit the same note in overlapping windows', () => {
  it('one save wins; the other resolves the conflict without losing either edit', async () => {
    const store = new Store({ seed: 1, count: 20, now: clock() });
    const ready = store.list({ statuses: ['READY_FOR_REVIEW'], limit: 1 }).items[0]!;
    const A = reviewer('usr_a');

    // A picks up the note; base version is the current head.
    store.transition(ready.id, { type: 'start_review' }, A);
    const base = store.get(ready.id)!.currentVersionId;
    const baseContent = contentOf(store, ready.id, base);

    // The other reviewer's save lands first, changing only the Subjective section.
    store.createVersion(
      ready.id,
      base,
      { sections: { ...baseContent.sections, S: 'colleague edit to subjective' } },
      reviewer('usr_b'),
      'mut_b',
    );
    const theirHead = store.get(ready.id)!.currentVersionId;

    // A edits a DIFFERENT section (Assessment) and autosaves from the now-stale base.
    const engine = new AutosaveEngine({ noteId: ready.id, baseVersionId: base, save: saveVia(store, A) });
    engine.change({ sections: { ...baseContent.sections, A: 'my edit to assessment' } });
    engine.flush();
    await tick();

    // A's UI is told there's a conflict — nothing overwritten.
    expect(engine.getState().status).toBe('conflict');

    // Resolve via the same three-way merge the UI uses. Different sections ->
    // auto-merge, so neither reviewer's work is lost.
    const mine = engine.getDraft()!;
    const merge = mergeContent(contentOf(store, ready.id, base), mine, contentOf(store, ready.id, theirHead));
    expect(merge.clean).toBe(true);
    const merged: NoteContent = {
      sections: {
        S: merge.sections.find((s) => s.section === 'S')!.merged!,
        O: merge.sections.find((s) => s.section === 'O')!.merged!,
        A: merge.sections.find((s) => s.section === 'A')!.merged!,
        P: merge.sections.find((s) => s.section === 'P')!.merged!,
      },
    };
    engine.resolveConflict(merged, theirHead);
    await tick();

    const finalContent = contentOf(store, ready.id, store.get(ready.id)!.currentVersionId);
    expect(engine.getState().status).toBe('idle');
    expect(finalContent.sections.S).toContain('colleague edit'); // their work survived
    expect(finalContent.sections.A).toContain('my edit'); // my work survived
  });
});

describe('Scenario 2: network drop mid-save with three queued mutations, reconnect 20 minutes later', () => {
  it('holds all three offline and replays them in order on reconnect', async () => {
    const connectivity = new ConnectivityMonitor({ initialOnline: false, addEventListeners: () => () => {} });
    let online = false;
    const applied: string[] = [];
    const save = async (entry: { clientMutationId: string }): Promise<ReplayResult> => {
      if (!online) return { status: 'error', retryable: true, message: 'offline' };
      applied.push(entry.clientMutationId);
      return { status: 'saved', version: { id: `ver_${entry.clientMutationId}`, revision: 2 } };
    };
    const queue = new WriteQueue({ storage: new MemoryQueueStorage(), save, now: clock() });

    // Three autosaves happen while offline.
    for (const m of ['m1', 'm2', 'm3']) {
      await queue.enqueue({ noteId: 'n1', baseVersionId: 'v1', content: soap({ S: m }), clientMutationId: m });
    }
    const offline = await queue.replay();
    expect(offline.status).toBe('paused-error');
    expect(queue.depth).toBe(3); // nothing lost while the network is down

    // ...20 minutes pass, then the link returns...
    online = true;
    connectivity.reportReachable();
    const resumed = await queue.replay();

    expect(resumed.status).toBe('idle');
    expect(applied).toEqual(['m1', 'm2', 'm3']); // exact order preserved
    expect(queue.depth).toBe(0);
  });
});

describe('Scenario 3: a status_changed arrives before the ack of the mutation that caused it', () => {
  it('applies the change once and dedupes the late ack by eventId', () => {
    const r = new Reconciler();
    const view: LocalView = {
      actor: reviewer('usr_a'),
      status: 'IN_REVIEW',
      assignedReviewerId: 'usr_a',
      approvedAt: null,
      headVersionId: 'v1',
      editing: false,
      saveInFlight: false,
    };
    r.setLocalView('n1', view);

    const push: ServerEvent = {
      type: 'note.status_changed',
      seq: 1,
      eventId: 'evt_approve',
      noteId: 'n1',
      fromStatus: 'IN_REVIEW',
      toStatus: 'APPROVED',
      actor: { id: 'usr_a', displayName: 'A' },
      at: 1000,
    };

    // The WS push lands BEFORE the REST ack of our own approve.
    const first = r.ingest(push);
    expect(first.kind).toBe('status');
    if (first.kind === 'status') expect(first.toStatus).toBe('APPROVED');

    // The ack finally arrives, carrying the same server eventId -> deduped.
    r.markSeen('evt_approve');
    const second = r.ingest(push);
    expect(second.kind).toBe('duplicate'); // applied exactly once, no double transition
  });
});

describe('Scenario 4: a REJECTED note is resubmitted after an admin superseded the base', () => {
  it('surfaces the conflict on resubmit and merges without losing the admin edit', async () => {
    const store = new Store({ seed: 2, count: 40, now: clock() });
    const rejected = store.list({ statuses: ['REJECTED'], limit: 1 }).items[0]!;
    const base = store.get(rejected.id)!.currentVersionId;
    const baseContent = contentOf(store, rejected.id, base);

    // An admin edits the rejected note's Objective section, advancing the head.
    store.createVersion(
      rejected.id,
      base,
      { sections: { ...baseContent.sections, O: 'admin corrected objective' } },
      admin('usr_admin'),
      'mut_admin',
    );
    const adminHead = store.get(rejected.id)!.currentVersionId;

    // A clinician resubmits, editing a different section, from the stale base.
    const clin = clinician('usr_clin');
    store.transition(rejected.id, { type: 'resubmit' }, clin); // REJECTED -> READY_FOR_REVIEW
    const engine = new AutosaveEngine({ noteId: rejected.id, baseVersionId: base, save: saveVia(store, clin) });
    engine.change({ sections: { ...baseContent.sections, P: 'clinician revised plan' } });
    engine.flush();
    await tick();

    expect(engine.getState().status).toBe('conflict'); // base was superseded

    const mine = engine.getDraft()!;
    const merge = mergeContent(contentOf(store, rejected.id, base), mine, contentOf(store, rejected.id, adminHead));
    const merged: NoteContent = {
      sections: {
        S: merge.sections.find((s) => s.section === 'S')!.merged!,
        O: merge.sections.find((s) => s.section === 'O')!.merged!,
        A: merge.sections.find((s) => s.section === 'A')!.merged!,
        P: merge.sections.find((s) => s.section === 'P')!.merged!,
      },
    };
    engine.resolveConflict(merged, adminHead);
    await tick();

    const finalContent = contentOf(store, rejected.id, store.get(rejected.id)!.currentVersionId);
    expect(finalContent.sections.O).toContain('admin corrected'); // admin's edit kept
    expect(finalContent.sections.P).toContain('clinician revised'); // clinician's edit kept
  });
});

describe('Scenario 5: reviewing 500 notes back-to-back leaks nothing', () => {
  it('opens and closes every subscription and keeps the dedupe set bounded', () => {
    let opened = 0;
    let closed = 0;
    const subscriptions = new SubscriptionManager(() => {
      opened += 1;
      return () => {
        closed += 1;
      };
    });
    const reconciler = new Reconciler({ maxSeen: 2000 });

    for (let i = 0; i < 500; i++) {
      const noteId = `note_${i}`;
      const release = subscriptions.acquire(noteId);
      reconciler.setLocalView(noteId, {
        actor: reviewer('usr_a'),
        status: 'IN_REVIEW',
        assignedReviewerId: 'usr_a',
        approvedAt: null,
        headVersionId: `v_${i}`,
        editing: false,
        saveInFlight: false,
      });
      // Each note receives a handful of events while open.
      for (let k = 0; k < 5; k++) {
        reconciler.ingest({
          type: 'note.presence',
          seq: i * 10 + k,
          eventId: `evt_${i}_${k}`,
          noteId,
          viewers: [],
          at: i,
        });
      }
      // Move on to the next note: tear this one down.
      release();
      reconciler.removeLocalView(noteId);
    }

    expect(subscriptions.openChannels).toBe(0); // no leaked subscriptions
    expect(opened).toBe(closed); // every open matched by a close
    expect(reconciler.seenCount).toBeLessThanOrEqual(2000); // dedupe set stayed bounded
  });
});
