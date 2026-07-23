/**
 * Reconnect policy for the real-time channel.
 *
 * Exponential backoff with jitter (so a fleet of clients doesn't reconnect in
 * lockstep after an outage), a ceiling, and a replay cursor: on every
 * successful (re)connect we ask the server for everything since the last event
 * we saw, because the brief is explicit — "do not assume the socket dropped
 * nothing".
 *
 * Clock, randomness and the connect attempt are all injected, so the whole
 * loop is driven deterministically in tests with no sockets and no real time.
 */

export interface BackoffOptions {
  initialMs: number;
  capMs: number;
  /** 0 = no jitter (pure exponential), 1 = full jitter. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 500, capMs: 30_000, jitter: 1 };

/**
 * Delay before retry `attempt` (1-based). Equal-jitter: half fixed, half
 * random, so delays stay bounded and monotone-ish while still spread out.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number): number {
  const exp = Math.min(opts.capMs, opts.initialMs * 2 ** (attempt - 1));
  const fixed = exp * (1 - opts.jitter);
  const random_ = exp * opts.jitter * random();
  return Math.floor(fixed + random_);
}

export type ConnectResult = { ok: true } | { ok: false };
/** Attempt a connection. Resolves ok on success. Never rejects. */
export type ConnectFn = () => Promise<ConnectResult>;

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type ConnState = 'connecting' | 'connected' | 'waiting';

export interface ReconnectOptions {
  connect: ConnectFn;
  /** Called after each successful connect with the current replay cursor. */
  onConnected: (cursor: number) => void;
  backoff?: BackoffOptions;
  scheduler?: Scheduler;
  random?: () => number;
}

/**
 * Drives connect attempts and retries. `cursor` is advanced by the caller as
 * events are applied, and read at reconnect time to request a replay.
 */
export class ReconnectController {
  private readonly connect: ConnectFn;
  private readonly onConnected: (cursor: number) => void;
  private readonly backoff: BackoffOptions;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;

  private attempt = 0;
  private state: ConnState = 'waiting';
  private handle: unknown = null;
  private stopped = true;
  private cursor = 0;

  constructor(opts: ReconnectOptions) {
    this.connect = opts.connect;
    this.onConnected = opts.onConnected;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.random = opts.random ?? Math.random;
  }

  /** Highest event seq applied so far; sent to the server as the replay point. */
  setCursor(seq: number): void {
    if (seq > this.cursor) this.cursor = seq;
  }

  getState(): ConnState {
    return this.state;
  }

  getAttempt(): number {
    return this.attempt;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tryConnect();
  }

  /** Called when the transport observes the connection dropped. */
  notifyDisconnected(): void {
    if (this.stopped) return;
    if (this.state === 'connecting') return; // already handling
    this.scheduleRetry();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      this.scheduler.clear(this.handle);
      this.handle = null;
    }
    this.state = 'waiting';
  }

  private tryConnect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    this.connect().then((result) => {
      if (this.stopped) return;
      if (result.ok) {
        this.attempt = 0;
        this.state = 'connected';
        this.onConnected(this.cursor); // request replay since last seen
      } else {
        this.scheduleRetry();
      }
    });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.state = 'waiting';
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    if (this.handle !== null) this.scheduler.clear(this.handle);
    this.handle = this.scheduler.set(() => {
      this.handle = null;
      this.tryConnect();
    }, delay);
  }
}
