/**
 * Reference-counted subscription manager.
 *
 * The brief requires subscribing to the real-time channel only for notes
 * currently on screen (list rows in view + the open detail) and unsubscribing
 * when they leave — across a 500-note session with no listener or subscription
 * leaks. Multiple UI parts can want the same note (a visible row AND the open
 * detail), so subscriptions are ref-counted: the underlying channel
 * subscription opens on the first request and closes only when the last
 * consumer releases it.
 *
 * Transport-agnostic: it drives an injected `open` function (the WebSocket/SSE
 * adapter). Bounded and leak-free by construction — every acquire returns a
 * release, and a channel with zero refs is torn down and forgotten.
 */

export type ChannelOpener = (noteId: string) => () => void;

interface Entry {
  refs: number;
  close: () => void;
}

export class SubscriptionManager {
  private readonly open: ChannelOpener;
  private readonly entries = new Map<string, Entry>();

  constructor(open: ChannelOpener) {
    this.open = open;
  }

  /**
   * Register interest in a note's channel. Opens the underlying subscription on
   * the first caller; subsequent callers just bump the ref count. Returns a
   * release function that is safe to call exactly once.
   */
  acquire(noteId: string): () => void {
    let entry = this.entries.get(noteId);
    if (!entry) {
      entry = { refs: 0, close: this.open(noteId) };
      this.entries.set(noteId, entry);
    }
    entry.refs += 1;

    let released = false;
    return () => {
      if (released) return; // idempotent release — double-calls are harmless
      released = true;
      const current = this.entries.get(noteId);
      if (!current) return;
      current.refs -= 1;
      if (current.refs <= 0) {
        current.close();
        this.entries.delete(noteId);
      }
    };
  }

  /**
   * Reconcile the live set to exactly `noteIds` (e.g. the notes now in the
   * viewport). Acquires newcomers, releases the departed. Returns nothing; the
   * manager owns the release handles internally for this bulk mode.
   */
  setActive(noteIds: Iterable<string>): void {
    const want = new Set(noteIds);
    // Release those no longer wanted.
    for (const id of [...this.bulkHandles.keys()]) {
      if (!want.has(id)) {
        this.bulkHandles.get(id)!();
        this.bulkHandles.delete(id);
      }
    }
    // Acquire newcomers.
    for (const id of want) {
      if (!this.bulkHandles.has(id)) {
        this.bulkHandles.set(id, this.acquire(id));
      }
    }
  }

  private readonly bulkHandles = new Map<string, () => void>();

  /** Number of distinct open channels — assert on this to prove no leaks. */
  get openChannels(): number {
    return this.entries.size;
  }

  /** Total outstanding references across all channels. */
  get totalRefs(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.refs;
    return n;
  }

  /** Tear everything down (e.g. on app unmount). */
  dispose(): void {
    for (const entry of this.entries.values()) entry.close();
    this.entries.clear();
    this.bulkHandles.clear();
  }
}
