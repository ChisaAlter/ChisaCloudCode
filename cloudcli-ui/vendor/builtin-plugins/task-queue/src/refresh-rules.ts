// The two ordering rules the Task Queue tab's refreshes depend on, as pure code so they
// have tests. index.ts calls listTasks, headless runs and dead letters in parallel, and
// parallel reads can resolve in any order; sequential ones could not.

/**
 * How long the backend's queue watcher waits after the last `.yml` change before it
 * broadcasts `tasks`. server.ts's startWatcher and the UI's refresh-skip rule both import
 * this, so the two cannot drift apart.
 */
export const WATCH_DEBOUNCE_MS = 1000;

/**
 * Last-started-wins. `begin()` marks a new load and returns a check that stays true only
 * until the next `begin()`. A load applies its result only if its check is still true, so
 * an older load that resolves late never overwrites what a newer one showed.
 */
export class Latest {
  private generation = 0;

  begin(): () => boolean {
    const mine = ++this.generation;
    return () => mine === this.generation;
  }
}

/**
 * Whether a watcher `tasks` event is already covered by a refresh that started at
 * `lastLoadStartedAt`, so a second one would re-read what the first already read.
 *
 * The backend broadcasts `watchDebounceMs` after the LAST change in a burst, so that change
 * happened no later than `eventAt - watchDebounceMs`. A refresh that started at or after
 * that point read the queue after the write. The case this exists for is the tab's own
 * button: the mutation returns, its refresh starts, and a second later the watcher reports
 * the same write. A change made elsewhere while no refresh was running still refreshes.
 *
 * Timer lateness and WebSocket latency only make `eventAt` later, which makes the estimated
 * change time later than the real one, so both err toward refreshing, never toward
 * skipping. Both times are on the same clock (`performance.now()` in the browser).
 */
export function coveredByRefresh(
  lastLoadStartedAt: number,
  eventAt: number,
  watchDebounceMs: number = WATCH_DEBOUNCE_MS,
): boolean {
  return lastLoadStartedAt >= eventAt - watchDebounceMs;
}
