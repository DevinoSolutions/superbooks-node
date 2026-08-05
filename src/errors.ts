/**
 * Error model.
 *
 * Everything the SDK throws derives from {@link SuperBooksError}, so a single
 * `catch (err) { if (err instanceof SuperBooksError) ... }` covers the surface.
 * The subclasses exist so callers can branch on the cases that need different
 * handling — bad credentials, missing permission, and rate limiting each call
 * for a different response, and telling them apart from a `status` number is
 * easy to get wrong.
 */

export type SuperBooksErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "bad_request"
  | "server_error"
  | "connection_error"
  | "protocol_error"
  | "tool_error";

export class SuperBooksError extends Error {
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status: number | undefined;
  readonly code: SuperBooksErrorCode;
  /**
   * JSON-RPC error code, when the failure arrived as a JSON-RPC error rather
   * than an HTTP status. Lives on the base class so a caller can tell the
   * server's original code apart from a generic transport failure.
   */
  readonly rpcCode: number | undefined;

  constructor(
    message: string,
    options: {
      code: SuperBooksErrorCode;
      status?: number | undefined;
      rpcCode?: number | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.rpcCode = options.rpcCode;
    // Keeps `instanceof` working when the package is consumed from CJS after
    // downlevelling, where extending a builtin can otherwise break the chain.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — the API key or OAuth token is missing, malformed, or revoked. */
export class SuperBooksAuthError extends SuperBooksError {
  constructor(message = "Unauthorized: check your SuperBooks API key", cause?: unknown) {
    super(message, { code: "unauthorized", status: 401, cause });
  }
}

/**
 * 403 — authenticated but not allowed. The usual causes are a credential whose
 * scopes do not cover the tool, a destructive tool while the team has not
 * enabled destructive AI tools, or a credential with no active team.
 */
export class SuperBooksPermissionError extends SuperBooksError {
  constructor(message = "Forbidden: credential lacks permission for this action", cause?: unknown) {
    super(message, { code: "forbidden", status: 403, cause });
  }
}

/** 429 — too many requests for this credential. */
export class SuperBooksRateLimitError extends SuperBooksError {
  /** Seconds to wait, parsed from the `Retry-After` response header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message = "Rate limited", retryAfterSeconds?: number | undefined, cause?: unknown) {
    super(message, { code: "rate_limited", status: 429, cause });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never produced an HTTP response (DNS, TCP, TLS, timeout, abort). */
export class SuperBooksConnectionError extends SuperBooksError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "connection_error", cause });
  }
}

/** A response arrived but was not a well-formed MCP/JSON-RPC message. */
export class SuperBooksProtocolError extends SuperBooksError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "protocol_error", cause });
  }
}

/**
 * The call succeeded at the transport level but the tool itself reported a
 * failure (JSON-RPC error, or a result carrying `isError: true`).
 */
export class SuperBooksToolError extends SuperBooksError {
  readonly toolName: string;
  readonly data: unknown;

  constructor(
    toolName: string,
    message: string,
    options: { rpcCode?: number | undefined; data?: unknown } = {},
  ) {
    super(message, { code: "tool_error", rpcCode: options.rpcCode });
    this.toolName = toolName;
    this.data = options.data;
  }
}

/**
 * Maps a non-2xx HTTP response to the right error class.
 *
 * `body` is the already-read response text; it is used as the message only
 * when it is short enough to be a real error string rather than an HTML page.
 */
export function errorFromResponse(
  status: number,
  body: string,
  retryAfter?: string | null,
): SuperBooksError {
  const detail = body.trim().length > 0 && body.trim().length <= 400 ? `: ${body.trim()}` : "";

  switch (status) {
    case 401:
      return new SuperBooksAuthError(`Unauthorized${detail || ": check your SuperBooks API key"}`);
    case 403:
      return new SuperBooksPermissionError(
        `Forbidden${detail || ": credential lacks permission for this action"}`,
      );
    case 429: {
      const parsed = retryAfter != null ? Number.parseInt(retryAfter, 10) : Number.NaN;
      const seconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
      return new SuperBooksRateLimitError(`Rate limited${detail}`, seconds);
    }
    default:
      return new SuperBooksError(`SuperBooks request failed with status ${status}${detail}`, {
        code: status >= 500 ? "server_error" : "bad_request",
        status,
      });
  }
}
