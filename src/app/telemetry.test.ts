import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALLOWLIST,
  MemoryParkStore,
  redact,
  Telemetry,
  type Scheduler,
  type TelemetryEvent,
  type TelemetrySink,
} from './telemetry.js';

const allow = new Set(DEFAULT_ALLOWLIST);

// --- redaction (the high-signal part) --------------------------------------

describe('redact', () => {
  it('keeps allowlisted primitive values', () => {
    const out = redact({ noteId: 'n1', status: 'IN_REVIEW', count: 3, retryable: true }, allow);
    expect(out).toEqual({ noteId: 'n1', status: 'IN_REVIEW', count: 3, retryable: true });
  });

  it('drops keys that are not allowlisted', () => {
    const out = redact({ noteId: 'n1', secretField: 'x' }, allow);
    expect(out).toEqual({ noteId: 'n1' });
  });

  it('never emits free-text note content, even under an allowlisted-looking key', () => {
    const out = redact(
      {
        noteId: 'n1',
        content: 'Patient reports chest pain radiating to the left arm',
        sectionText: 'Subjective: ...',
        transcript: 'full transcript here',
      },
      allow,
    );
    expect(out).toEqual({ noteId: 'n1' }); // all free-text keys stripped
  });

  it('strips obvious PII keys by substring even if allowlisted', () => {
    const withName = new Set([...DEFAULT_ALLOWLIST, 'patientName', 'email']);
    const out = redact({ noteId: 'n1', patientName: 'Riley A.', email: 'a@b.com' }, withName);
    expect(out).toEqual({ noteId: 'n1' });
  });

  it('drops long strings that are likely free text', () => {
    const long = 'x'.repeat(500);
    const out = redact({ status: long }, allow);
    expect(out).toEqual({});
  });

  it('drops nested objects and arrays', () => {
    const out = redact({ noteId: 'n1', payload: { a: 1 }, tags: ['x'] }, allow);
    expect(out).toEqual({ noteId: 'n1' });
  });

  it('does not mutate the input', () => {
    const input = { noteId: 'n1', content: 'secret' };
    const copy = { ...input };
    redact(input, allow);
    expect(input).toEqual(copy);
  });
});

// --- pipeline ---------------------------------------------------------------

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

/** Runs scheduled callbacks synchronously — collapses backoff delays so an
 *  awaited flush traverses all retries to completion. */
const immediateScheduler: Scheduler = {
  set: (fn) => {
    fn();
    return 0;
  },
  clear: () => {},
};

/**
 * Drive an async operation that awaits ManualScheduler timers to completion:
 * interleave microtask draining with firing pending timers until it settles.
 */
async function settle(p: Promise<unknown>, scheduler: ManualScheduler): Promise<void> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let i = 0; i < 100 && !done; i++) {
    await Promise.resolve();
    if (scheduler.pending > 0) scheduler.runAll();
  }
  await p;
}

const okSink = () => {
  const batches: TelemetryEvent[][] = [];
  const sink: TelemetrySink = async (b) => {
    batches.push(b);
    return { ok: true };
  };
  return { sink, batches };
};

describe('batching and flush triggers', () => {
  it('buffers below the size threshold without sending', () => {
    const { sink, batches } = okSink();
    const t = new Telemetry({ sink, sizeThreshold: 5, scheduler: new ManualScheduler() });
    t.track('a');
    t.track('b');
    expect(batches).toHaveLength(0);
    expect(t.bufferSize).toBe(2);
  });

  it('flushes when the size threshold is reached', async () => {
    const { sink, batches } = okSink();
    const t = new Telemetry({ sink, sizeThreshold: 2, scheduler: new ManualScheduler() });
    t.track('a');
    t.track('b');
    await flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('flushes immediately for an important event', async () => {
    const { sink, batches } = okSink();
    const t = new Telemetry({ sink, sizeThreshold: 100, scheduler: new ManualScheduler() });
    t.track('critical', {}, { important: true });
    await flush();
    expect(batches).toHaveLength(1);
  });

  it('flushes on a time threshold', async () => {
    const { sink, batches } = okSink();
    const scheduler = new ManualScheduler();
    const t = new Telemetry({ sink, sizeThreshold: 100, scheduler });
    t.track('a');
    expect(batches).toHaveLength(0);
    scheduler.runAll(); // time fires
    await flush();
    expect(batches).toHaveLength(1);
  });

  it('flushes on a session boundary (route change / tab hidden)', async () => {
    const { sink, batches } = okSink();
    const t = new Telemetry({ sink, sizeThreshold: 100, scheduler: new ManualScheduler() });
    t.track('a');
    t.flushOnBoundary();
    await flush();
    expect(batches).toHaveLength(1);
  });
});

describe('retry then park', () => {
  it('retries with backoff on failure', async () => {
    let calls = 0;
    const sink: TelemetrySink = async () => {
      calls += 1;
      return calls < 2 ? { ok: false } : { ok: true };
    };
    const scheduler = new ManualScheduler();
    const park = new MemoryParkStore();
    const t = new Telemetry({ sink, park, scheduler, maxRetries: 3, sizeThreshold: 100 });
    t.track('a');
    await settle(t.flush(), scheduler); // fires the backoff timer, runs the retry
    expect(calls).toBe(2);
    expect((await park.getAll()).length).toBe(0); // succeeded, nothing parked
  });

  it('parks the batch after exhausting retries', async () => {
    const sink: TelemetrySink = async () => ({ ok: false });
    const scheduler = new ManualScheduler();
    const park = new MemoryParkStore();
    const t = new Telemetry({ sink, park, scheduler, maxRetries: 2, sizeThreshold: 100 });
    t.track('a', { noteId: 'n1' });
    await settle(t.flush(), scheduler);
    const parked = await park.getAll();
    expect(parked.length).toBe(1);
    expect(parked[0]!.batch[0]!.name).toBe('a');
  });

  it('drains parked batches on startup', async () => {
    const park = new MemoryParkStore();
    await park.put('p1', [{ name: 'old', props: {}, ts: 1 }]);
    const { sink, batches } = okSink();
    const t = new Telemetry({ sink, park, scheduler: new ManualScheduler() });
    await t.drainParked();
    expect(batches).toHaveLength(1);
    expect((await park.getAll()).length).toBe(0); // cleared after successful resend
  });
});

describe('unload', () => {
  it('uses the beacon for the final flush', () => {
    const beaconBatches: TelemetryEvent[][] = [];
    const beacon = (b: TelemetryEvent[]) => {
      beaconBatches.push(b);
      return true;
    };
    const { sink } = okSink();
    const t = new Telemetry({ sink, beacon, scheduler: new ManualScheduler(), sizeThreshold: 100 });
    t.track('a');
    t.flushOnUnload();
    expect(beaconBatches).toHaveLength(1);
    expect(t.bufferSize).toBe(0);
  });

  it('parks the final batch if the beacon is unavailable', async () => {
    const park = new MemoryParkStore();
    const { sink } = okSink();
    const t = new Telemetry({ sink, park, beacon: () => false, scheduler: new ManualScheduler(), sizeThreshold: 100 });
    t.track('a');
    t.flushOnUnload();
    await flush();
    expect((await park.getAll()).length).toBe(1);
  });
});

describe('facade discipline', () => {
  it('redacts on the way in, so events reach the sink already clean', async () => {
    const spy = vi.fn(async (_batch: TelemetryEvent[]) => ({ ok: true }));
    const t = new Telemetry({ sink: spy, scheduler: immediateScheduler, sizeThreshold: 1 });
    t.track('edit', { noteId: 'n1', content: 'PHI here' });
    await t.flush();
    expect(spy).toHaveBeenCalled();
    const batch = spy.mock.calls[0]![0];
    expect(batch[0]!.props).toEqual({ noteId: 'n1' }); // content stripped before send
  });
});
