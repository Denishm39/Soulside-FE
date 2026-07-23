import { describe, expect, it, vi } from 'vitest';
import {
  AutosaveEngine,
  type SaveFn,
  type SaveOutcome,
  type SaveRequest,
  type Scheduler,
} from './autosave.js';
import type { NoteContent } from '../domain/types.js';

// --- deterministic scheduler ------------------------------------------------
// Records timers instead of using real time; the test fires them explicitly.

class ManualScheduler implements Scheduler {
  private handle = 0;
  private readonly timers = new Map<number, { fn: () => void; ms: number }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.handle;
    this.timers.set(id, { fn, ms });
    return id;
  }

  clear(h: unknown): void {
    this.timers.delete(h as number);
  }

  /** Fire every currently-scheduled timer (in insertion order). */
  runAll(): void {
    for (const [id, t] of [...this.timers]) {
      this.timers.delete(id);
      t.fn();
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

// --- controllable save fn ---------------------------------------------------
// Each call returns a promise the test resolves by hand, so save timing is
// fully under control.

class Deferred<T> {
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  readonly promise = new Promise<T>((res, rej) => {
    this.resolve = res;
    this.reject = rej;
  });
}

const makeSaver = () => {
  const calls: SaveRequest[] = [];
  const deferreds: Array<Deferred<SaveOutcome>> = [];
  const save: SaveFn = (req) => {
    calls.push(req);
    const d = new Deferred<SaveOutcome>();
    deferreds.push(d);
    return d.promise;
  };
  return { save, calls, deferreds };
};

const content = (tag: string): NoteContent => ({ sections: { S: tag, O: '', A: '', P: '' } });
const saved = (id: string, revision = 2): SaveOutcome => ({ status: 'saved', version: { id, revision } });

const flush = () => Promise.resolve();

const setup = (over: Partial<Parameters<typeof mk>[0]> = {}) => mk(over);
function mk(over: Record<string, unknown> = {}) {
  const scheduler = new ManualScheduler();
  const saver = makeSaver();
  let idn = 0;
  const engine = new AutosaveEngine({
    noteId: 'note_1',
    baseVersionId: 'ver_1',
    save: saver.save,
    debounceMs: 800,
    scheduler,
    newMutationId: () => `mut_${++idn}`,
    ...over,
  });
  return { engine, scheduler, ...saver };
}

// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('does not save until the debounce elapses', () => {
    const { engine, scheduler, calls } = setup();
    engine.change(content('a'));
    expect(engine.getState().status).toBe('dirty');
    expect(calls).toHaveLength(0);
    scheduler.runAll();
    expect(calls).toHaveLength(1);
    expect(engine.getState().status).toBe('saving');
  });

  it('coalesces rapid edits into a single save with the latest content', () => {
    const { engine, scheduler, calls } = setup();
    engine.change(content('a'));
    engine.change(content('b'));
    engine.change(content('c'));
    scheduler.runAll();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toEqual(content('c'));
  });

  it('flush saves immediately, skipping the debounce', () => {
    const { engine, calls } = setup();
    engine.change(content('a'));
    engine.flush();
    expect(calls).toHaveLength(1);
  });
});

describe('single-flight and coalescing', () => {
  it('never issues two concurrent saves for the same note', async () => {
    const { engine, scheduler, calls } = setup();
    engine.change(content('a'));
    scheduler.runAll(); // first save in flight
    expect(calls).toHaveLength(1);

    // more edits arrive mid-flight
    engine.change(content('b'));
    engine.change(content('c'));
    scheduler.runAll(); // debounce must NOT open a second POST
    expect(calls).toHaveLength(1);
    expect(engine.getState().hasUnsavedChanges).toBe(true);
  });

  it('runs exactly one coalesced follow-up after the in-flight save lands', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();

    engine.change(content('b'));
    engine.change(content('c')); // both collapse into one pending

    deferreds[0]!.resolve(saved('ver_2'));
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.content).toEqual(content('c'));
    expect(calls[1]!.baseVersionId).toBe('ver_2'); // follow-up branches from new head
  });

  it('returns to idle when a save lands with no pending edits', async () => {
    const { engine, scheduler, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();
    deferreds[0]!.resolve(saved('ver_2'));
    await flush();
    const s = engine.getState();
    expect(s.status).toBe('idle');
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.lastSavedVersionId).toBe('ver_2');
    expect(s.baseVersionId).toBe('ver_2');
  });
});

describe('idempotency', () => {
  it('reuses one mutation id across retries of the same save', async () => {
    const { engine, scheduler, calls, deferreds } = setup({ maxRetries: 3 });
    engine.change(content('a'));
    scheduler.runAll();

    deferreds[0]!.resolve({ status: 'error', retryable: true, message: 'timeout' });
    await flush();
    expect(engine.getState().status).toBe('retrying');

    scheduler.runAll(); // backoff fires -> retry
    deferreds[1]!.resolve(saved('ver_2'));
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.clientMutationId).toBe(calls[1]!.clientMutationId); // same id
    expect(calls[1]!.attempt).toBe(2);
  });

  it('mints a fresh mutation id for a genuinely new save', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();
    deferreds[0]!.resolve(saved('ver_2'));
    await flush();

    engine.change(content('b'));
    scheduler.runAll();
    expect(calls[0]!.clientMutationId).not.toBe(calls[1]!.clientMutationId);
  });
});

describe('retry with backoff', () => {
  it('gives up after maxRetries and surfaces the error, keeping the draft', async () => {
    const { engine, scheduler, calls, deferreds } = setup({ maxRetries: 2 });
    engine.change(content('a'));
    scheduler.runAll();

    deferreds[0]!.resolve({ status: 'error', retryable: true, message: 'boom' });
    await flush();
    scheduler.runAll();
    deferreds[1]!.resolve({ status: 'error', retryable: true, message: 'boom' });
    await flush();

    const s = engine.getState();
    expect(calls).toHaveLength(2); // initial + 1 retry, capped at maxRetries
    expect(s.status).toBe('error');
    expect(s.hasUnsavedChanges).toBe(true);
    expect(engine.getDraft()).toEqual(content('a'));
  });

  it('does not retry a non-retryable error', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();
    deferreds[0]!.resolve({ status: 'error', retryable: false, message: 'forbidden' });
    await flush();
    expect(engine.getState().status).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('treats a rejected save promise as a retryable transport error', async () => {
    const { engine, scheduler, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();
    deferreds[0]!.reject(new Error('offline'));
    await flush();
    expect(engine.getState().status).toBe('retrying');
  });

  it('manual retry from the error state re-sends the draft', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('a'));
    scheduler.runAll();
    deferreds[0]!.resolve({ status: 'error', retryable: false, message: 'x' });
    await flush();

    engine.retryNow();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.content).toEqual(content('a'));
  });
});

describe('conflict', () => {
  it('surfaces head + ancestor and does not overwrite', async () => {
    const { engine, scheduler, deferreds } = setup();
    engine.change(content('mine'));
    scheduler.runAll();
    deferreds[0]!.resolve({
      status: 'conflict',
      current: { id: 'ver_9', revision: 7 },
      commonAncestor: { id: 'ver_4', revision: 4 },
    });
    await flush();

    const s = engine.getState();
    expect(s.status).toBe('conflict');
    expect(s.conflict?.current.id).toBe('ver_9');
    expect(s.conflict?.commonAncestor?.id).toBe('ver_4');
    expect(engine.getDraft()).toEqual(content('mine')); // work preserved
  });

  it('does not auto-save while a conflict is unresolved', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('mine'));
    scheduler.runAll();
    deferreds[0]!.resolve({ status: 'conflict', current: { id: 'v', revision: 2 }, commonAncestor: null });
    await flush();

    engine.change(content('more edits'));
    scheduler.runAll();
    expect(calls).toHaveLength(1); // still just the one attempt
    expect(engine.getState().status).toBe('conflict');
  });

  it('resolveConflict continues from merged content against the new head', async () => {
    const { engine, scheduler, calls, deferreds } = setup();
    engine.change(content('mine'));
    scheduler.runAll();
    deferreds[0]!.resolve({ status: 'conflict', current: { id: 'ver_9', revision: 7 }, commonAncestor: null });
    await flush();

    engine.resolveConflict(content('merged'), 'ver_9');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.content).toEqual(content('merged'));
    expect(calls[1]!.baseVersionId).toBe('ver_9');
    expect(calls[1]!.clientMutationId).not.toBe(calls[0]!.clientMutationId); // fresh save
    expect(engine.getState().conflict).toBeNull();
  });
});

describe('external head updates', () => {
  it('adopts a server version only when clean', () => {
    const { engine } = setup();
    engine.adoptServerVersion('ver_5');
    expect(engine.getState().baseVersionId).toBe('ver_5');
  });

  it('ignores a server version while there are unsaved edits', () => {
    const { engine } = setup();
    engine.change(content('a'));
    engine.adoptServerVersion('ver_5');
    expect(engine.getState().baseVersionId).toBe('ver_1'); // reconciler's call, not ours
  });
});

describe('lifecycle hygiene', () => {
  it('stops emitting and cancels timers after dispose', async () => {
    const { engine, scheduler, deferreds } = setup();
    const seen: string[] = [];
    engine.subscribe((s) => seen.push(s.status));
    engine.change(content('a'));
    scheduler.runAll();
    engine.dispose();
    const before = seen.length;
    deferreds[0]?.resolve(saved('ver_2')); // late outcome must be ignored
    await flush();
    expect(seen.length).toBe(before);
    expect(scheduler.pending).toBe(0);
  });

  it('notifies subscribers on state changes', () => {
    const { engine } = setup();
    const fn = vi.fn();
    engine.subscribe(fn);
    engine.change(content('a'));
    expect(fn).toHaveBeenCalled();
    expect(fn.mock.calls.at(-1)![0].status).toBe('dirty');
  });
});
