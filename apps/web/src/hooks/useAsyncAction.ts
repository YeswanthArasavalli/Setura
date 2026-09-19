import { useCallback, useRef, useState } from "react";
import { newIdempotencyKey } from "@/lib/idempotency";

interface AsyncState<T> {
  running: boolean;
  data: T | null;
  error: unknown | null;
}

/**
 * Guard a single backend mutation against accidental double submission
 * (Phase 6 §19).
 *
 * - `running` drives UI disabling so a second click cannot fire.
 * - A per-submission idempotency key is generated once and reused across
 *   retries of the SAME logical action via the `keyRef`, so a replay never
 *   creates a duplicate resource. This is a convenience layer only — the
 *   backend's idempotency system is the final protection.
 *
 * `fn` receives the stable idempotency key for this submission.
 */
export function useAsyncAction<TArgs extends unknown[], TRes>(
  fn: (key: string, ...args: TArgs) => Promise<TRes>,
) {
  const [state, setState] = useState<AsyncState<TRes>>({
    running: false,
    data: null,
    error: null,
  });
  const keyRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (...args: TArgs): Promise<TRes | null> => {
      if (inFlight.current) return null; // swallow double-submit
      inFlight.current = true;
      const key = (keyRef.current ??= newIdempotencyKey("action"));
      setState((s) => ({ ...s, running: true, error: null }));
      try {
        const data = await fn(key, ...args);
        setState({ running: false, data, error: null });
        return data;
      } catch (error) {
        setState((s) => ({ ...s, running: false, error }));
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [fn],
  );

  /** Start a brand-new submission (fresh idempotency key). */
  const reset = useCallback(() => {
    keyRef.current = null;
    setState({ running: false, data: null, error: null });
  }, []);

  return { ...state, run, reset };
}
