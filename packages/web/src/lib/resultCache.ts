/**
 * Browser-side result cache (IndexedDB) so profiles, schemas, plans, widget data and the last result of every tab
 * paint instantly on the next visit — then revalidate against the server with `If-None-Match` (a 304 costs one
 * `stat` and a hash on the server, no DuckDB work).
 *
 * Correctness is the server's job: every entry stores the ETag the server issued, and an entry is only ever shown
 * as *current* after the server confirmed it (304) or replaced it (200). Until then the UI marks it "cached".
 *
 * Privacy: entries are scoped by user id and wiped on logout / session loss. `localStorage` is not used — a single
 * 5 000-row result can exceed its quota; IndexedDB gives hundreds of MB, capped here by an LRU byte budget.
 * Every call is wrapped so a blocked/private-mode IndexedDB degrades to "no cache", never to an error.
 */

export type CacheKind = 'overview' | 'profile' | 'inspect' | 'explain' | 'widget' | 'query' | 'tab';

export interface CacheEntry<T = unknown> {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: CacheKind;
  /** Server ETag (null for tab results, which are never revalidated — they are restored, not trusted). */
  etag: string | null;
  computed_at: string;
  stored_at: number;
  bytes: number;
  payload: T;
}

const DB_NAME = 'duckview-cache';
const STORE = 'entries';
const VERSION = 1;
/** LRU budget across all users on this browser profile. */
export const BUDGET_BYTES = 150 * 1024 * 1024;
/** Entries above this are not persisted (a huge grid re-runs instead of eating the budget). */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('workspace_id', 'workspace_id');
          store.createIndex('user_id', 'user_id');
          store.createIndex('stored_at', 'stored_at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          const req = fn(store);
          if (req) {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
          } else {
            t.oncomplete = () => resolve(undefined);
            t.onerror = () => resolve(undefined);
          }
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export const cacheId = (userId: string, workspaceId: string, kind: CacheKind, target: string) => `${userId}|${workspaceId}|${kind}|${target}`;

export const resultCache = {
  async get<T>(id: string): Promise<CacheEntry<T> | undefined> {
    const e = await tx<CacheEntry<T>>('readonly', (s) => s.get(id));
    if (e) void tx('readwrite', (s) => s.put({ ...e, stored_at: Date.now() })); // touch for LRU
    return e;
  },

  async set<T>(entry: Omit<CacheEntry<T>, 'stored_at' | 'bytes'>): Promise<boolean> {
    let bytes = 0;
    try {
      bytes = new Blob([JSON.stringify(entry.payload)]).size;
    } catch {
      return false;
    }
    if (bytes > MAX_ENTRY_BYTES) return false;
    await tx('readwrite', (s) => s.put({ ...entry, stored_at: Date.now(), bytes }));
    void this.trim();
    return true;
  },

  async remove(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id));
  },

  /** Drops entries of one workspace (delete / leave) — for the current user or everyone. */
  async clearWorkspace(workspaceId: string): Promise<void> {
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const t = db.transaction(STORE, 'readwrite');
        const idx = t.objectStore(STORE).index('workspace_id');
        const req = idx.openKeyCursor(IDBKeyRange.only(workspaceId));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          t.objectStore(STORE).delete(c.primaryKey);
          c.continue();
        };
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  },

  async clearAll(): Promise<void> {
    await tx('readwrite', (s) => s.clear());
  },

  async stats(): Promise<{ entries: number; bytes: number }> {
    const all = (await tx<CacheEntry[]>('readonly', (s) => s.getAll())) ?? [];
    return { entries: all.length, bytes: all.reduce((a, e) => a + (e.bytes ?? 0), 0) };
  },

  /** Evicts least-recently-stored entries until the budget holds. Runs after every write; cheap for a few hundred entries. */
  async trim(): Promise<void> {
    const all = (await tx<CacheEntry[]>('readonly', (s) => s.getAll())) ?? [];
    let total = all.reduce((a, e) => a + (e.bytes ?? 0), 0);
    if (total <= BUDGET_BYTES) return;
    const oldestFirst = [...all].sort((a, b) => a.stored_at - b.stored_at);
    const victims: string[] = [];
    for (const e of oldestFirst) {
      if (total <= BUDGET_BYTES) break;
      victims.push(e.id);
      total -= e.bytes ?? 0;
    }
    await tx('readwrite', (s) => {
      for (const id of victims) s.delete(id);
    });
  },
};
