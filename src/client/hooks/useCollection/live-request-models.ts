/**
 * Callbacks for a live (reactive) collection request such as `query`, `getAll` or `distinct`.
 *
 * Passing these makes the request live: it re-runs whenever the local collection changes or the
 * server subscription pushes an update, and reports each result through `onResponse`.
 */
export interface LiveRequestCallbacks<Response> {
  /** Receives the first result and every later result that differs from the previous one. */
  onResponse(result: Response): void;
  /** Called when a re-run produces the same result as the one last delivered. */
  onSameResponse?(): void;
  /**
   * Receives failures of the reactive re-runs, which nothing else awaits. A failure of the initial
   * run rejects the returned promise instead. When omitted, re-run failures are logged.
   */
  onError?(error: unknown): void;
}
