/**
 * Connectivity monitor.
 *
 * Single source of truth for online/offline, driving the non-modal status
 * indicator the brief asks for and kicking off queue replay on reconnect.
 *
 * The browser's `navigator.onLine` is necessary but not sufficient — it goes
 * true the instant an interface is up, before the server is actually reachable.
 * So we distinguish three states, and let the transport report reachability
 * failures (a timed-out fetch) to move us to `unstable` without waiting for the
 * OS to admit the link is down.
 *
 * Event sources are injected so this is testable without a real `window`.
 */

export type Connectivity = 'online' | 'offline' | 'unstable';

export interface ConnectivitySources {
  /** Initial guess. Defaults to navigator.onLine when present, else true. */
  initialOnline?: boolean;
  /** Subscribe to browser online/offline. Returns an unsubscribe fn. */
  addEventListeners?: (onOnline: () => void, onOffline: () => void) => () => void;
}

type Listener = (state: Connectivity) => void;

function defaultListeners(onOnline: () => void, onOffline: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

export class ConnectivityMonitor {
  private state: Connectivity;
  private readonly listeners = new Set<Listener>();
  private readonly unbind: () => void;

  constructor(sources: ConnectivitySources = {}) {
    const initial =
      sources.initialOnline ??
      (typeof navigator !== 'undefined' ? navigator.onLine : true);
    this.state = initial ? 'online' : 'offline';
    const bind = sources.addEventListeners ?? defaultListeners;
    this.unbind = bind(
      () => this.set('online'),
      () => this.set('offline'),
    );
  }

  get(): Connectivity {
    return this.state;
  }

  isOnline(): boolean {
    return this.state === 'online';
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** The transport observed a reachability failure while the OS still says online. */
  reportUnreachable(): void {
    if (this.state === 'online') this.set('unstable');
  }

  /** The transport completed a request successfully — we are genuinely online. */
  reportReachable(): void {
    if (this.state !== 'offline') this.set('online');
  }

  dispose(): void {
    this.unbind();
    this.listeners.clear();
  }

  private set(next: Connectivity): void {
    if (next === this.state) return;
    this.state = next;
    for (const fn of [...this.listeners]) fn(next);
  }
}
