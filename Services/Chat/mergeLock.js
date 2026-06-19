// Services/Chat/mergeLock.js — DBR-P4-6 (DESIGN §7.2): the merge land-only lock + FIFO queue.
//
// At cap>1, N dev runs PREPARE their merges in parallel — sync + `npm test` + the human confirm, each in its own
// `.wt/` worktree, slow and lock-free. The LAND step alone (`git switch main` + `merge --squash` + commit, in the
// ONE repo-root `main` tree) must be SERIAL: `main` is a single shared checkout, so two squash-lands at once collide
// — the exact recurring dogfooding pain this whole arc exists to kill. This module is that serialization point: a
// pure FIFO lock — one holder lands at a time, everyone else queues in arrival order and auto-promotes on release.
//
// The reducer (makeLockState / acquire / release / queueDepth / position) is PURE + immutable (no timers, no async,
// new state every call) so the land-serialization logic is fully unit-tested. `createMergeLock` is the thin async
// wrapper the panel actually holds: a grant becomes a resolved Promise carrying a release fn. Panel-side only — the
// panel is the sole merge coordinator (§10.1 preview instances never land), so an in-memory lock is sufficient.

/** Fresh lock state: nobody holds it, nobody waiting. */
export function makeLockState() {
  return { holder: null, queue: [] };
}

/**
 * Request the lock for `id`. Pure → returns `{ state, granted, position }` (input untouched).
 * - free                    → `id` becomes holder; granted:true,  position:0
 * - `id` already holds it   → idempotent;          granted:true,  position:0
 * - held by someone else    → `id` joins the FIFO queue (no dup);  granted:false, position:Nth-in-line (1-based)
 * - `id` nullish            → rejected;             granted:false, position:-1
 */
export function acquire(state, id) {
  const s = _clone(state);
  if (id == null) return { state: s, granted: false, position: -1 };
  if (s.holder === id) return { state: s, granted: true, position: 0 };
  if (s.holder == null) { s.holder = id; return { state: s, granted: true, position: 0 }; }
  if (s.queue.indexOf(id) === -1) s.queue.push(id);
  return { state: s, granted: false, position: s.queue.indexOf(id) + 1 };
}

/**
 * Release or withdraw `id`. Pure → returns `{ state, next }` (input untouched).
 * - `id` is holder          → promote the FIFO head to holder (or null if empty); next = the new holder (or null)
 * - `id` is queued (cancel) → drop it from the queue; the holder is unchanged;     next = null
 * - `id` is neither         → no-op;                                               next = null
 */
export function release(state, id) {
  const s = _clone(state);
  if (id != null && s.holder === id) {
    s.holder = s.queue.length ? s.queue.shift() : null;
    return { state: s, next: s.holder };
  }
  const at = id == null ? -1 : s.queue.indexOf(id);
  if (at !== -1) s.queue.splice(at, 1);
  return { state: s, next: null };
}

/** How many are waiting (the holder is not counted). */
export function queueDepth(state) {
  return Array.isArray(state && state.queue) ? state.queue.length : 0;
}

/** `id`'s place: 0 = holds the lock, N = Nth in line (1-based), -1 = not present. */
export function position(state, id) {
  if (!state || id == null) return -1;
  if (state.holder === id) return 0;
  const at = Array.isArray(state.queue) ? state.queue.indexOf(id) : -1;
  return at === -1 ? -1 : at + 1;
}

function _clone(state) {
  return {
    holder: state && state.holder != null ? state.holder : null,
    queue: Array.isArray(state && state.queue) ? state.queue.slice() : [],
  };
}

/**
 * The live land-lock the panel holds around the squash-land critical section. One holder at a time; concurrent
 * callers await their turn FIFO. `acquire(id, onWait?)` resolves to a `release()` fn — ALWAYS call it in a finally
 * (a never-released land would wedge every queued merge behind it). `onWait(position)` fires once, when the caller
 * has to queue, with its 1-based "Nth in line" so the panel can render *"waiting to merge — Nth in line"*.
 */
export function createMergeLock() {
  let state = makeLockState();
  const waiters = new Map();   // id → fn that resolves that caller's acquire() promise

  function _acquire(id, onWait) {
    const r = acquire(state, id);
    state = r.state;
    if (r.granted) return Promise.resolve(() => _release(id));
    if (typeof onWait === 'function') { try { onWait(r.position); } catch { /* reporting is best-effort */ } }
    return new Promise((resolve) => waiters.set(id, () => resolve(() => _release(id))));
  }

  function _release(id) {
    waiters.delete(id);                    // a still-queued canceler: drop its pending resolver too
    const r = release(state, id);
    state = r.state;
    if (r.next != null) {
      const wake = waiters.get(r.next);
      waiters.delete(r.next);
      if (wake) wake();                    // promote the head: its acquire() promise now resolves with the lock
    }
  }

  return {
    acquire: _acquire,
    depth: () => queueDepth(state),
    position: (id) => position(state, id),
  };
}
