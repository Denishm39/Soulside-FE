import { describe, expect, it } from 'vitest';
import { mulberry32, Rng } from './rng.js';
import { compareKeyset, decodeCursor, encodeCursor, isAfter } from './cursor.js';
import { Store } from './store.js';
import { MockBackend, ServerError } from './backend.js';
import { RealtimeChannel } from './realtime.js';
import type { Actor, NoteContent } from '../domain/types.js';

const content = (tag: string): NoteContent => ({
  sections: { S: tag, O: tag, A: tag, P: tag },
});

const reviewer = (id: string): Actor => ({ id, role: 'REVIEWER', mfaVerifiedAt: Date.now() });

// A fixed clock keeps createVersion ids and updatedAt deterministic under test.
// Starts past the seed date range (seeds live in Nov 2025) so that a "touched"
// note gets a genuinely newer updatedAt and sorts to the front as expected.
const fixedClock = () => {
  let t = Date.UTC(2027, 0, 1);
  return () => (t += 1000);
};

// ---------------------------------------------------------------------------

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays within [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Rng helpers', () => {
  it('int stays within bounds inclusive', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 500; i++) {
      const v = rng.int(5, 9);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it('pick throws on empty input', () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });
});

describe('cursor', () => {
  it('round-trips a keyset opaquely', () => {
    const key = { sortValue: 1_700_000_000_000, id: 'note_00042' };
    const token = encodeCursor(key);
    expect(token).not.toContain('note_00042'); // opaque, not human-readable
    expect(decodeCursor(token)).toEqual(key);
  });

  it('returns null for garbage tokens rather than throwing', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(encodeCursor as unknown as string)).toBeNull();
  });

  it('orders by sortValue desc then id asc', () => {
    const older = { sortValue: 100, id: 'b' };
    const newer = { sortValue: 200, id: 'a' };
    expect(compareKeyset(newer, older)).toBeLessThan(0); // newer first
    const tieA = { sortValue: 100, id: 'a' };
    const tieB = { sortValue: 100, id: 'b' };
    expect(compareKeyset(tieA, tieB)).toBeLessThan(0); // id asc breaks tie
  });

  it('isAfter is true only for rows strictly past the cursor', () => {
    const cursor = { sortValue: 100, id: 'm' };
    expect(isAfter(cursor, { sortValue: 90, id: 'a' })).toBe(true); // older => later page
    expect(isAfter(cursor, { sortValue: 100, id: 'z' })).toBe(true); // same time, larger id
    expect(isAfter(cursor, { sortValue: 100, id: 'm' })).toBe(false); // the cursor row itself
    expect(isAfter(cursor, { sortValue: 110, id: 'a' })).toBe(false); // newer => earlier page
  });
});

describe('Store seeding', () => {
  it('is deterministic — same seed produces identical state', () => {
    const a = new Store({ seed: 5, count: 200 });
    const b = new Store({ seed: 5, count: 200 });
    const idsA = a.list({ limit: 200 }).items.map((n) => `${n.id}:${n.status}:${n.updatedAt}`);
    const idsB = b.list({ limit: 200 }).items.map((n) => `${n.id}:${n.status}:${n.updatedAt}`);
    expect(idsA).toEqual(idsB);
  });

  it('produces the requested number of notes', () => {
    expect(new Store({ seed: 1, count: 137 }).size).toBe(137);
  });

  it('gives every note a resolvable head version', () => {
    const store = new Store({ seed: 2, count: 100 });
    for (const note of store.list({ limit: 100 }).items) {
      expect(note.versions.some((v) => v.versionId === note.currentVersionId)).toBe(true);
    }
  });
});

describe('cursor pagination over the full dataset', () => {
  it('walks every row exactly once with no gaps or duplicates', () => {
    const store = new Store({ seed: 9, count: 1000 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: ReturnType<Store['list']> = store.list({ cursor, limit: 50 });
      seen.push(...page.items.map((n) => n.id));
      cursor = page.cursor.next;
      pages += 1;
      expect(pages).toBeLessThan(50); // guard against an infinite loop
    } while (cursor);

    expect(seen.length).toBe(1000);
    expect(new Set(seen).size).toBe(1000); // no duplicates
  });

  it('keeps a stable order across pages', () => {
    // count stays under MAX_LIMIT so the single-shot list can serve as ground truth.
    const store = new Store({ seed: 4, count: 150 });
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<Store['list']> = store.list({ cursor, limit: 25 });
      all.push(...page.items.map((n) => n.id));
      cursor = page.cursor.next;
    } while (cursor);

    const oneShot = store.list({ limit: 1000 }).items.map((n) => n.id);
    expect(all).toEqual(oneShot);
  });

  it('reports hasMore correctly on the last page', () => {
    const store = new Store({ seed: 1, count: 60 });
    const p1 = store.list({ limit: 50 });
    expect(p1.cursor.hasMore).toBe(true);
    const p2 = store.list({ cursor: p1.cursor.next, limit: 50 });
    expect(p2.cursor.hasMore).toBe(false);
    expect(p2.cursor.next).toBeNull();
  });
});

describe('Store filtering and search', () => {
  it('filters by status', () => {
    const store = new Store({ seed: 3, count: 500 });
    const result = store.list({ statuses: ['APPROVED'], limit: 500 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((n) => n.status === 'APPROVED')).toBe(true);
  });

  it('distinguishes an unfiltered list from a no-results search', () => {
    const store = new Store({ seed: 3, count: 200 });
    expect(store.list({ limit: 200 }).items.length).toBe(200);
    expect(store.list({ search: 'zzz-nonexistent-zzz', limit: 200 }).items.length).toBe(0);
  });

  it('searches note content, not just patient name', () => {
    const store = new Store({ seed: 3, count: 100 });
    // Seeded content always contains this stub phrase.
    const hits = store.list({ search: 'follow up', limit: 100 });
    expect(hits.items.length).toBeGreaterThan(0);
  });
});

describe('createVersion — idempotency and conflict', () => {
  const setup = () => {
    const store = new Store({ seed: 1, count: 10, now: fixedClock() });
    const note = store.list({ limit: 1 }).items[0]!;
    return { store, note };
  };

  it('appends a new head version on a clean save', () => {
    const { store, note } = setup();
    // list() returns live record references, so snapshot the base id before the
    // save mutates note.currentVersionId in place.
    const base = note.currentVersionId;
    const result = store.createVersion(note.id, base, content('edited'), reviewer('usr_chen'), 'mut_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deduped).toBe(false);
    expect(store.get(note.id)!.currentVersionId).toBe(result.version.versionId);
    expect(result.version.parentVersionId).toBe(base);
  });

  it('is idempotent — a duplicate clientMutationId creates nothing', () => {
    const { store, note } = setup();
    const first = store.createVersion(note.id, note.currentVersionId, content('a'), reviewer('u'), 'mut_dup');
    const countAfterFirst = store.get(note.id)!.versions.length;

    const second = store.createVersion(
      note.id,
      // even with a now-stale base, the mutation id short-circuits
      'ver_totally_stale',
      content('a'),
      reviewer('u'),
      'mut_dup',
    );

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.deduped).toBe(true);
      expect(second.version.versionId).toBe(first.version.versionId);
    }
    expect(store.get(note.id)!.versions.length).toBe(countAfterFirst);
  });

  it('rejects a stale base with version_conflict and returns head + ancestor', () => {
    const { store, note } = setup();
    const base = note.currentVersionId;
    // Someone else advances the head first.
    store.createVersion(note.id, base, content('theirs'), reviewer('other'), 'mut_other');

    const conflict = store.createVersion(note.id, base, content('mine'), reviewer('me'), 'mut_mine');
    expect(conflict.ok).toBe(false);
    if (conflict.ok || conflict.error !== 'version_conflict') throw new Error('expected a version_conflict');
    expect(conflict.current.versionId).toBe(store.get(note.id)!.currentVersionId);
    // common ancestor is the base both edits share
    expect(conflict.commonAncestor?.versionId).toBe(base);
  });
});

describe('Store.transition goes through the domain machine', () => {
  it('applies a legal transition and logs an event', () => {
    const store = new Store({ seed: 1, count: 50, now: fixedClock() });
    const ready = store.list({ statuses: ['READY_FOR_REVIEW'], limit: 1 }).items[0]!;
    const result = store.transition(ready.id, { type: 'start_review' }, reviewer('usr_chen'));
    expect(result.ok).toBe(true);
    const after = store.get(ready.id)!;
    expect(after.status).toBe('IN_REVIEW');
    expect(after.assignedReviewerId).toBe('usr_chen');
    expect(after.events.at(-1)?.toStatus).toBe('IN_REVIEW');
  });

  it('refuses an illegal transition with the machine reason', () => {
    const store = new Store({ seed: 1, count: 50 });
    const ready = store.list({ statuses: ['READY_FOR_REVIEW'], limit: 1 }).items[0]!;
    const result = store.transition(ready.id, { type: 'approve' }, reviewer('x'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('touch keeps the sort order consistent', () => {
  it('moves an edited note to the front and preserves pagination integrity', () => {
    const store = new Store({ seed: 6, count: 100, now: fixedClock() });
    const target = store.list({ limit: 100 }).items.at(-1)!; // currently last
    store.createVersion(target.id, target.currentVersionId, content('x'), reviewer('u'), 'm');

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<Store['list']> = store.list({ cursor, limit: 20 });
      ids.push(...page.items.map((n) => n.id));
      cursor = page.cursor.next;
    } while (cursor);

    expect(ids[0]).toBe(target.id); // newest updatedAt now sorts first
    expect(ids.length).toBe(100);
    expect(new Set(ids).size).toBe(100); // still no gaps or dupes
  });
});

describe('RealtimeChannel', () => {
  it('delivers events to the right note subscribers only', () => {
    const ch = new RealtimeChannel({ random: () => 0.99 });
    const a: string[] = [];
    const b: string[] = [];
    ch.subscribe('note_a', (e) => a.push(e.eventId));
    ch.subscribe('note_b', (e) => b.push(e.eventId));

    ch.emit({ type: 'note.presence', eventId: 'e1', noteId: 'note_a', viewers: [], at: 0 });
    expect(a).toEqual(['e1']);
    expect(b).toEqual([]);
  });

  it('unsubscribe stops delivery and drops empty channels', () => {
    const ch = new RealtimeChannel({ random: () => 0.99 });
    const seen: string[] = [];
    const off = ch.subscribe('n', (e) => seen.push(e.eventId));
    ch.emit({ type: 'note.presence', eventId: 'e1', noteId: 'n', viewers: [], at: 0 });
    off();
    ch.emit({ type: 'note.presence', eventId: 'e2', noteId: 'n', viewers: [], at: 0 });
    expect(seen).toEqual(['e1']);
    expect(ch.subscriberCount).toBe(0);
  });

  it('duplicates on the live stream when the dice say so (at-least-once)', () => {
    const ch = new RealtimeChannel({ random: () => 0 }); // 0 => never drop, always duplicate
    const seen: string[] = [];
    ch.subscribe('n', (e) => seen.push(e.eventId));
    ch.emit({ type: 'note.presence', eventId: 'e1', noteId: 'n', viewers: [], at: 0 }, { duplicateRate: 1 });
    expect(seen).toEqual(['e1', 'e1']); // delivered twice
  });

  it('recovers dropped events through replaySince', () => {
    const ch = new RealtimeChannel({ random: () => 0.9 }); // 0.9 >= dropRate 1? no -> drop
    const live: string[] = [];
    ch.subscribe('n', (e) => live.push(e.eventId));
    const emitted = ch.emit(
      { type: 'note.presence', eventId: 'e1', noteId: 'n', viewers: [], at: 0 },
      { dropRate: 1 },
    );
    expect(live).toEqual([]); // dropped from the live push
    const replay = ch.replaySince(0); // but recoverable
    expect(replay.map((e) => e.eventId)).toEqual(['e1']);
    expect(emitted.seq).toBe(ch.cursor);
  });

  it('replaySince returns only events after the cursor, in order', () => {
    const ch = new RealtimeChannel({ random: () => 0.99 });
    ch.emit({ type: 'note.presence', eventId: 'e1', noteId: 'n', viewers: [], at: 0 });
    const mid = ch.cursor;
    ch.emit({ type: 'note.presence', eventId: 'e2', noteId: 'n', viewers: [], at: 0 });
    ch.emit({ type: 'note.presence', eventId: 'e3', noteId: 'n', viewers: [], at: 0 });
    expect(ch.replaySince(mid).map((e) => e.eventId)).toEqual(['e2', 'e3']);
  });
});

describe('MockBackend fault injection', () => {
  const noSleep = (_ms: number) => Promise.resolve();

  it('runs clean when faults are disabled', async () => {
    const be = new MockBackend({ seed: 1, count: 20, faults: { enabled: false } });
    const page = await be.listNotes({ limit: 20 });
    expect(page.items.length).toBe(20);
  });

  it('injects failures at the configured rate', async () => {
    // random always below failureRate => always fails
    const be = new MockBackend({
      seed: 1,
      count: 10,
      random: () => 0.0,
      sleep: noSleep,
      faults: { enabled: true, minLatencyMs: 0, maxLatencyMs: 0, failureRate: 0.05 },
    });
    await expect(be.listNotes()).rejects.toBeInstanceOf(ServerError);
  });

  it('succeeds when the dice clear the failure threshold', async () => {
    const be = new MockBackend({
      seed: 1,
      count: 10,
      random: () => 0.99,
      sleep: noSleep,
      faults: { enabled: true, minLatencyMs: 0, maxLatencyMs: 0, failureRate: 0.05 },
    });
    const page = await be.listNotes();
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('emits a version_added event on a successful save by the assigned reviewer', async () => {
    const be = new MockBackend({ seed: 1, count: 50, faults: { enabled: false } });
    // Editing is only permitted for an IN_REVIEW note by its assigned reviewer.
    const note = (await be.listNotes({ statuses: ['IN_REVIEW'], limit: 1 })).items[0]!;
    const author = reviewer(note.assignedReviewerId!);
    const seen: string[] = [];
    be.realtime.subscribe(note.id, (e) => seen.push(e.type));
    const result = await be.saveVersion(
      note.id,
      { baseVersionId: note.currentVersionId, content: content('x'), clientMutationId: 'm1' },
      author,
    );
    expect(result.ok).toBe(true);
    expect(seen).toContain('note.version_added');
  });

  it('refuses a save to a note the caller may not edit (server authorization)', async () => {
    const be = new MockBackend({ seed: 1, count: 100, faults: { enabled: false } });
    const locked = (await be.listNotes({ statuses: ['LOCKED'], limit: 1 })).items[0]!;
    // A hostile client posts a version to a LOCKED note — the server must refuse.
    const result = await be.saveVersion(
      locked.id,
      { baseVersionId: locked.currentVersionId, content: content('evil'), clientMutationId: 'm_evil' },
      reviewer('usr_attacker'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
  });

  it('surfaces a 404 for an unknown note', async () => {
    const be = new MockBackend({ seed: 1, count: 5, faults: { enabled: false } });
    await expect(be.getNote('note_missing')).rejects.toMatchObject({ status: 404 });
  });
});
