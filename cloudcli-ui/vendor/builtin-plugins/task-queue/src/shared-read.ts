// One in-flight read, shared by every caller that asks while it is running.
//
// The Task Queue tab loads `/tasks` and `/headless-runs` together, and both need the same
// unfiltered `GET /tasks` from task-queue-mcp: the first to render the list, the second to
// match launch logs to task status (queueIndexByPrefix). Before v0.12.0 each route made its
// own read, so every refresh fetched the whole active queue twice.
//
// This shares the READ, never a RESULT. A settled promise is dropped at once, so nothing is
// served from memory after the read that produced it has finished, and there is no time
// window to reason about. Two calls share a read only if the second arrives while the first
// is still on the wire, which is exactly the case the UI's parallel loads create.
//
// `invalidate()` detaches the in-flight read, so a caller arriving after it starts a fresh
// one. The backend calls it when a mutation returns and when the queue watcher fires. A
// read that began before a mutation may reflect the old state, and a request made after the
// mutation returned must not be handed it. Callers that already joined the old read keep
// it: they asked before the mutation finished, so an answer from before it is not stale to
// them.
//
// A failed read is shared with the callers already waiting on it, and with no one after.

export class SharedRead<T> {
  private inflight: Promise<T> | null = null;
  // Not a parameter property: `npm test` runs this file under Node's type stripping,
  // which rejects them.
  private readonly load: () => Promise<T>;

  constructor(load: () => Promise<T>) {
    this.load = load;
  }

  get(): Promise<T> {
    if (this.inflight) return this.inflight;
    const p = this.load();
    this.inflight = p;
    // Clear only if this read is still the current one. After an invalidate() and a newer
    // read, the older one settling must not detach the newer.
    const clear = (): void => {
      if (this.inflight === p) this.inflight = null;
    };
    p.then(clear, clear);
    return p;
  }

  invalidate(): void {
    this.inflight = null;
  }
}

/**
 * Run a write, then invalidate `shared` before returning, whether the write succeeded,
 * was refused, or failed in transport (a lost response does not prove the write did not
 * land). The caller responds only after this returns, so any read requested after the
 * response starts fresh.
 */
export async function invalidatingWrite<R>(
  shared: SharedRead<unknown>,
  write: () => Promise<R>,
): Promise<R> {
  try {
    return await write();
  } finally {
    shared.invalidate();
  }
}
