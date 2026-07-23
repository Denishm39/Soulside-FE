/**
 * Telemetry pipeline.
 *
 * A single track() facade — no component ever calls the telemetry endpoint
 * directly. Events are redacted, batched, and flushed on a size threshold, a
 * time threshold, and session boundaries (route change, tab hidden). Failed
 * batches retry with backoff and, after N attempts, are parked in storage for a
 * later drain. On unload the final flush uses a beacon so nothing is lost.
 *
 * The redaction pass is default-deny: only allowlisted, primitive, short-enough
 * property values survive, and a denylist backstops obvious PII keys. Free-text
 * note content therefore cannot reach the wire even if a caller passes it by
 * mistake — which is the property the brief insists on.
 *
 * Transport, beacon, storage, clock and scheduler are all injected, so the
 * whole pipeline is unit-tested with no network and no real time.
 */

export interface TelemetryEvent {
  name: string;
  props: Record<string, string | number | boolean>;
  ts: number;
}

export interface TrackOptions {
  /** Flush immediately rather than waiting for a threshold. */
  important?: boolean;
}

export type TelemetrySink = (batch: TelemetryEvent[]) => Promise<{ ok: boolean }>;
/** Synchronous best-effort send for unload. Returns whether it was accepted. */
export type BeaconSink = (batch: TelemetryEvent[]) => boolean;

export interface ParkStore {
  put(id: string, batch: TelemetryEvent[]): Promise<void>;
  getAll(): Promise<Array<{ id: string; batch: TelemetryEvent[] }>>;
  delete(id: string): Promise<void>;
}

export class MemoryParkStore implements ParkStore {
  private readonly map = new Map<string, TelemetryEvent[]>();
  put(id: string, batch: TelemetryEvent[]): Promise<void> {
    this.map.set(id, batch);
    return Promise.resolve();
  }
  getAll(): Promise<Array<{ id: string; batch: TelemetryEvent[] }>> {
    return Promise.resolve([...this.map].map(([id, batch]) => ({ id, batch })));
  }
  delete(id: string): Promise<void> {
    this.map.delete(id);
    return Promise.resolve();
  }
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// --- redaction --------------------------------------------------------------

/** Structural keys that are safe to emit. Anything else is dropped. */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'noteId',
  'patientId',
  'status',
  'fromStatus',
  'toStatus',
  'role',
  'actorRole',
  'action',
  'capability',
  'result',
  'outcome',
  'durationMs',
  'count',
  'revision',
  'versionId',
  'eventId',
  'route',
  'feature',
  'errorCode',
  'retryable',
  'attempt',
  'queueDepth',
  'connectivity',
];

/** Keys that must never be emitted even if allowlisted by mistake. */
const DENY_SUBSTRINGS = [
  'content',
  'text',
  'section',
  'transcript',
  'note.body',
  'body',
  'summary',
  'name',
  'email',
  'dob',
  'ssn',
  'phone',
  'address',
  'reason', // rejection reasons are free text
];

const MAX_STRING_LEN = 128;

/**
 * Keep only allowlisted keys whose values are primitives and short enough to be
 * structural rather than free text. Returns a new object; never mutates input.
 */
export function redact(
  props: Record<string, unknown>,
  allowlist: ReadonlySet<string>,
  maxLen = MAX_STRING_LEN,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    const lower = key.toLowerCase();
    if (DENY_SUBSTRINGS.some((s) => lower.includes(s))) continue;
    if (!allowlist.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string' && value.length <= maxLen) {
      out[key] = value;
    }
    // objects, arrays, long strings, null, undefined: dropped
  }
  return out;
}

// --- pipeline ---------------------------------------------------------------

export interface TelemetryOptions {
  sink: TelemetrySink;
  beacon?: BeaconSink;
  park?: ParkStore;
  scheduler?: Scheduler;
  now?: () => number;
  sizeThreshold?: number;
  timeThresholdMs?: number;
  maxRetries?: number;
  backoffMs?: (attempt: number) => number;
  allowlist?: readonly string[];
}

let parkSeq = 0;

export class Telemetry {
  private readonly sink: TelemetrySink;
  private readonly beacon: BeaconSink | null;
  private readonly park: ParkStore | null;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly sizeThreshold: number;
  private readonly timeThresholdMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly allowlist: ReadonlySet<string>;

  private buffer: TelemetryEvent[] = [];
  private timeHandle: unknown = null;
  private disposed = false;

  constructor(opts: TelemetryOptions) {
    this.sink = opts.sink;
    this.beacon = opts.beacon ?? null;
    this.park = opts.park ?? null;
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.now = opts.now ?? Date.now;
    this.sizeThreshold = opts.sizeThreshold ?? 20;
    this.timeThresholdMs = opts.timeThresholdMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? ((n) => 500 * 2 ** (n - 1));
    this.allowlist = new Set(opts.allowlist ?? DEFAULT_ALLOWLIST);
  }

  /** The one entry point. Redacts, buffers, and flushes on threshold. */
  track(name: string, props: Record<string, unknown> = {}, opts: TrackOptions = {}): void {
    if (this.disposed) return;
    this.buffer.push({ name, props: redact(props, this.allowlist), ts: this.now() });

    if (opts.important || this.buffer.length >= this.sizeThreshold) {
      void this.flush();
    } else {
      this.armTimeFlush();
    }
  }

  /** Flush the current buffer as one batch, retrying then parking on failure. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.clearTimeFlush();
    const batch = this.buffer;
    this.buffer = [];
    await this.send(batch, 1);
  }

  /** Session boundary: route change or tab hidden. */
  flushOnBoundary(): void {
    void this.flush();
  }

  /**
   * Final flush on unload. Uses the beacon (synchronous, survives teardown);
   * if it can't send, the batch is parked so a later session drains it.
   */
  flushOnUnload(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.clearTimeFlush();
    const accepted = this.beacon ? this.beacon(batch) : false;
    if (!accepted && this.park) void this.park.put(this.nextParkId(), batch);
  }

  /** On startup, resend anything parked by a previous session. */
  async drainParked(): Promise<void> {
    if (!this.park) return;
    const parked = await this.park.getAll();
    for (const { id, batch } of parked) {
      const result = await this.sink(batch).catch(() => ({ ok: false }));
      if (result.ok) await this.park.delete(id);
    }
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimeFlush();
  }

  // -- internals ------------------------------------------------------------

  private async send(batch: TelemetryEvent[], attempt: number): Promise<void> {
    const result = await this.sink(batch).catch(() => ({ ok: false }));
    if (result.ok) return;

    if (attempt < this.maxRetries) {
      await this.delay(this.backoffMs(attempt));
      if (this.disposed) {
        if (this.park) await this.park.put(this.nextParkId(), batch);
        return;
      }
      await this.send(batch, attempt + 1);
      return;
    }
    // Exhausted: park for a later attempt rather than dropping.
    if (this.park) await this.park.put(this.nextParkId(), batch);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduler.set(resolve, ms);
    });
  }

  private armTimeFlush(): void {
    if (this.timeHandle !== null) return; // already armed
    this.timeHandle = this.scheduler.set(() => {
      this.timeHandle = null;
      void this.flush();
    }, this.timeThresholdMs);
  }

  private clearTimeFlush(): void {
    if (this.timeHandle !== null) {
      this.scheduler.clear(this.timeHandle);
      this.timeHandle = null;
    }
  }

  private nextParkId(): string {
    return `${this.now()}_${++parkSeq}`;
  }
}
