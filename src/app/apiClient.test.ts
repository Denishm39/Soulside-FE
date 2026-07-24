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
  it('maps a successful save to a saved SaveOutcome', async () => {
    const { api } = makeApi();
    const note = (await api.listNotes({ limit: 1 })).items[0]!;
    const outcome = await api.saveVersion(
      { noteId: note.id, baseVersionId: note.currentVersionId, content: content('x'), clientMutationId: 'm1', attempt: 1 },
      actor('u'),
    );
    expect(outcome.status).toBe('saved');
    if (outcome.status === 'saved') expect(outcome.version.id).toBeTruthy();
  });

  it('maps a stale base to a conflict SaveOutcome with head + ancestor', async () => {
    const { api } = makeApi();
    const note = (await api.listNotes({ limit: 1 })).items[0]!;
    const base = note.currentVersionId;
    // Someone else advances the head first.
    await api.saveVersion(
      { noteId: note.id, baseVersionId: base, content: content('theirs'), clientMutationId: 'm_other', attempt: 1 },
      actor('other'),
    );
    const outcome = await api.saveVersion(
      { noteId: note.id, baseVersionId: base, content: content('mine'), clientMutationId: 'm_mine', attempt: 1 },
      actor('me'),
    );
    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.current.id).toBeTruthy();
      expect(outcome.commonAncestor?.id).toBe(base);
    }
  });
});
