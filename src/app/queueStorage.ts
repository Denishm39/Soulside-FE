/**
 * Storage backends for the write queue.
 *
 * MemoryQueueStorage: non-persistent, for tests and SSR fallback.
 * IdbQueueStorage: IndexedDB-backed, so the queue survives a full page reload —
 *   the durability guarantee the brief requires. A tiny hand-rolled wrapper
 *   keeps this dependency-free; the surface is small enough not to warrant a lib.
 */

import type { QueuedWrite, QueueStorage } from './writeQueue.js';

export class MemoryQueueStorage implements QueueStorage {
  private readonly map = new Map<string, QueuedWrite>();

  getAll(): Promise<QueuedWrite[]> {
    return Promise.resolve([...this.map.values()]);
  }
  put(entry: QueuedWrite): Promise<void> {
    this.map.set(entry.id, entry);
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    this.map.delete(id);
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.map.clear();
    return Promise.resolve();
  }
}

const DB_NAME = 'soulside-notes';
const STORE = 'write-queue';
const DB_VERSION = 1;

export class IdbQueueStorage implements QueueStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = fn(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(): Promise<QueuedWrite[]> {
    const rows = await this.tx<QueuedWrite[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedWrite[]>);
    return rows;
  }
  async put(entry: QueuedWrite): Promise<void> {
    await this.tx('readwrite', (s) => s.put(entry));
  }
  async delete(id: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(id));
  }
  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => s.clear());
  }
}

/** Pick the durable backend when available, else fall back to memory. */
export function createQueueStorage(): QueueStorage {
  return IdbQueueStorage.isSupported() ? new IdbQueueStorage() : new MemoryQueueStorage();
}
