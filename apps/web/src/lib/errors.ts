/**
 * Typed error surfaced to the UI from the Edge Function layer.
 *
 * Honest error handling (Phase 6 §18): we preserve the backend's safe
 * message + code + field errors and map status to an intent. We never
 * surface SQL, stack traces, secrets or internal detail — the backend
 * envelope already carries only client-safe messages.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;
  readonly retryable: boolean;
  readonly correlationId?: string;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
    correlationId?: string;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.fieldErrors = args.fieldErrors;
    this.retryable = args.retryable ?? false;
    this.correlationId = args.correlationId;
  }

  /** Human category for the UI (§18 mapping). */
  get kind():
    | "auth"
    | "forbidden"
    | "validation"
    | "conflict"
    | "rate_limit"
    | "server"
    | "network"
    | "unknown"
  {
    if (this.status === 0) return "network";
    if (this.status === 401) return "auth";
    if (this.status === 403) return "forbidden";
    if (this.status === 422) return "validation";
    if (this.status === 409) return "conflict";
    if (this.status === 429) return "rate_limit";
    if (this.status >= 500) return "server";
    return "unknown";
  }
}

/** Short, non-sensitive guidance per error kind for banners. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "auth":
        return "Your session expired. Please sign in again.";
      case "forbidden":
        return "You do not have permission to perform this action.";
      case "validation":
        return err.message || "Please correct the highlighted fields.";
      case "conflict":
        return err.message || "This conflicts with the current state.";
      case "rate_limit":
        return "Too many requests — please wait a moment and retry.";
      case "server":
        return "The server could not complete the request. Please retry.";
      case "network":
        return "Cannot reach the server. Check your connection.";
      default:
        return err.message || "Request failed.";
    }
  }
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}
