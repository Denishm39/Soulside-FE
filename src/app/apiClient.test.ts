import { describe, expect, it } from 'vitest';
import { MockBackend } from '../data/backend.js';
import { BackendApi } from './apiClient.js';
import type { Actor, NoteContent } from '../domain/types.js';

const actor = (id: string): Actor => ({ id, role: 'REVIEWER', mfaVerifiedAt: Date.now() });
const content = (tag: string): NoteContent => ({ sections: { S: tag, O: '', A: '', P: '' } });

/** A clean, deterministic backend (no latency/faults) for adapter tests. */
const makeApi = () => {
  const backend = new MockBackend({ seed: 1, count: 20, faults: { enabled: false } });
  return { api: new BackendApi(backend), backend };
};

describe('BackendApi.transition', () => {
  it('threads the server-assigned eventId through on success', async () => {
    const { api } = makeApi();
    const ready = (await api.listNotes({ statuses: ['READY_FOR_REVIEW'], limit: 1 })).items[0]!;
    const result = await api.transition(ready.id, { type: 'start_review' }, actor('usr_chen'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventId).toMatch(/^evt_/); // real id, not discarded
  });

  it('returns a reason (not an eventId) when the server rejects', async () => {
    const { api } = makeApi();
    const ready = (await api.listNotes({ statuses: ['READY_FOR_REVIEW'], limit: 1 })).items[0]!;
    // approve is illegal from READY_FOR_REVIEW
    const result = await api.transition(ready.id, { type: 'approve' }, actor('usr_x'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('BackendApi.saveVersion mapping', () => {
  // Editing is only permitted for an IN_REVIEW note by its assigned reviewer.
  const editableNote = async (api: ReturnType<typeof makeApi>['api']) => {
    const note = (await api.listNotes({ statuses: ['IN_REVIEW'], limit: 1 })).items[0]!;
    return { note, author: actor(note.assignedReviewerId!) };
  };

  it('maps a successful save to a saved SaveOutcome', async () => {
    const { api } = makeApi();
    const { note, author } = await editableNote(api);
    const outcome = await api.saveVersion(
      { noteId: note.id, baseVersionId: note.currentVersionId, content: content('x'), clientMutationId: 'm1', attempt: 1 },
      author,
    );
    expect(outcome.status).toBe('saved');
    if (outcome.status === 'saved') expect(outcome.version.id).toBeTruthy();
  });

  it('maps a stale base to a conflict SaveOutcome with head + ancestor', async () => {
    const { api } = makeApi();
    const { note, author } = await editableNote(api);
    const base = note.currentVersionId;
    // The assigned reviewer advances the head first.
    await api.saveVersion(
      { noteId: note.id, baseVersionId: base, content: content('theirs'), clientMutationId: 'm_other', attempt: 1 },
      author,
    );
    const outcome = await api.saveVersion(
      { noteId: note.id, baseVersionId: base, content: content('mine'), clientMutationId: 'm_mine', attempt: 1 },
      author,
    );
    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.current.id).toBeTruthy();
      expect(outcome.commonAncestor?.id).toBe(base);
    }
  });

  it('maps a forbidden save (e.g. a LOCKED note) to a non-retryable error', async () => {
    const { api } = makeApi();
    const locked = (await api.listNotes({ statuses: ['LOCKED'], limit: 1 })).items[0]!;
    const outcome = await api.saveVersion(
      { noteId: locked.id, baseVersionId: locked.currentVersionId, content: content('x'), clientMutationId: 'm_l', attempt: 1 },
      actor('usr_attacker'),
    );
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.retryable).toBe(false);
  });
});
