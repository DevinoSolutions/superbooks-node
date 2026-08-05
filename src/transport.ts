/**
 * Minimal MCP client over the Streamable HTTP transport.
 *
 * This is hand-rolled rather than pulled from an MCP SDK dependency because
 * the client half of Streamable HTTP that this package needs is genuinely
 * small: POST a JSON-RPC message, accept either a JSON body or a one-shot SSE
 * stream in reply, and carry the session id header. Keeping it here is what
 * lets `superbooks` install with zero runtime dependencies.
 */

import {
  SuperBooksConnectionError,
  SuperBooksError,
  SuperBooksProtocolError,
  SuperBooksRateLimitError,
  SuperBooksToolError,
  errorFromResponse,
} from "./errors.js";
import type { ContentBlock, ToolDefinition, ToolResult } from "./types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface TransportOptions {
  /** Origin of the SuperBooks MCP endpoint, e.g. `https://api.superbooks.io`. */
  baseUrl: string;
  /** Team API key (`sb_…`) or OAuth access token. */
  apiKey: string;
  /** Injection point for tests and for proxy-aware fetch implementations. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request. Cannot override `Authorization`. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms. Default 60000. Pass 0 to disable. */
  timeoutMs?: number;
  /** Retries for rate-limited requests. Default 2. Pass 0 to disable. */
  maxRetries?: number;
  /** Upper bound in seconds on an honoured `Retry-After`. Default 60. */
  maxRetryDelaySeconds?: number;
  /** Advertised to the server during `initialize`. */
  clientInfo?: { name: string; version: string };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulls JSON-RPC messages out of an SSE body.
 *
 * The server may answer a POST with `text/event-stream` instead of JSON. For a
 * single request that stream carries the response and then ends, so reading it
 * to completion and picking out the `data:` payloads is sufficient — there is
 * no long-lived subscription to manage.
 */
export function parseSseMessages(body: string): unknown[] {
  const messages: unknown[] = [];

  for (const rawEvent of body.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;

    const payload = dataLines.join("\n");
    if (payload === "" || payload === "[DONE]") continue;

    try {
      messages.push(JSON.parse(payload));
    } catch {
      // A non-JSON data frame is a keep-alive or comment, not our response.
    }
  }

  return messages;
}

export class McpTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelaySeconds: number;
  private readonly clientInfo: { name: string; version: string };

  private sessionId: string | undefined;
  private nextId = 1;
  private initializing: Promise<void> | undefined;

  constructor(options: TransportOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    // `/mcp` is the public entry point; a baseUrl that already names it is
    // accepted so callers can paste the URL straight out of the docs.
    this.endpoint = base.endsWith("/mcp") ? base : `${base}/mcp`;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    // Drop any caller-supplied Authorization up front, in EVERY case variant.
    // Header names are case-insensitive on the wire but distinct as object
    // keys, so a lowercase `authorization` would survive the spread in
    // buildHeaders and reach fetch alongside ours — where Headers merges the
    // two into one comma-joined value and the credential is no longer solely
    // ours. Copying also detaches us from later mutation of the caller's object.
    this.extraHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(
        ([name]) => name.toLowerCase() !== "authorization",
      ),
    );
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryDelaySeconds = options.maxRetryDelaySeconds ?? 60;
    this.clientInfo = options.clientInfo ?? { name: "superbooks-node", version: "0.1.0" };

    if (typeof this.fetchImpl !== "function") {
      throw new SuperBooksError(
        "No fetch implementation available. Use Node 20+ or pass `fetch` explicitly.",
        { code: "connection_error" },
      );
    }
  }

  /** The resolved endpoint, exposed for diagnostics and tests. */
  get url(): string {
    return this.endpoint;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      // Bearer covers both credential kinds: an `sb_`-prefixed value is
      // resolved as a team API key, anything else as an OAuth access token.
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async post(payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const controller = new AbortController();
      const timer =
        this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: this.buildHeaders(),
          body,
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        throw new SuperBooksConnectionError(
          aborted
            ? `Request to ${this.endpoint} timed out after ${this.timeoutMs}ms`
            : `Could not reach ${this.endpoint}`,
          err,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      if (response.ok) return response;

      const text = await response.text().catch(() => "");
      const error = errorFromResponse(response.status, text, response.headers.get("retry-after"));

      // Only 429 is retried. A rate-limited request was rejected before the
      // tool ran, so replaying it is safe. A 5xx may well have executed a
      // write already, and tool calls are not guaranteed idempotent — retrying
      // those could double-send an invoice, so the caller decides instead.
      if (error instanceof SuperBooksRateLimitError && attempt < this.maxRetries) {
        const wait = Math.min(error.retryAfterSeconds ?? 2 ** attempt, this.maxRetryDelaySeconds);
        await sleep(wait * 1000);
        continue;
      }

      throw error;
    }
  }

  /** Extracts the JSON-RPC response matching `id` from a JSON or SSE body. */
  private async readResponse(response: Response, id: number): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    const candidates: unknown[] = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : [
          (() => {
            try {
              return JSON.parse(text) as unknown;
            } catch (err) {
              throw new SuperBooksProtocolError(
                `Expected a JSON-RPC response from ${this.endpoint} but the body was not JSON`,
                err,
              );
            }
          })(),
        ];

    for (const candidate of candidates) {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "id" in candidate &&
        (candidate as JsonRpcResponse).id === id
      ) {
        return candidate as JsonRpcResponse;
      }
    }

    throw new SuperBooksProtocolError(
      `No JSON-RPC response with id ${id} was returned by ${this.endpoint}`,
    );
  }

  /**
   * Sends a request and returns its `result`, raising on a JSON-RPC error.
   *
   * `toolName` is set only by {@link callTool}; supplying it is what turns a
   * JSON-RPC error into a {@link SuperBooksToolError} naming the tool.
   */
  async request<T = unknown>(method: string, params?: unknown, toolName?: string): Promise<T> {
    if (method !== "initialize") await this.ensureInitialized();
    return this.rawRequest<T>(method, params, toolName);
  }

  private async rawRequest<T>(method: string, params?: unknown, toolName?: string): Promise<T> {
    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const message = await this.readResponse(response, id);

    if (message.error) {
      const text = message.error.message || `${method} failed`;
      // A tool that rejects via JSON-RPC and a tool that returns isError are
      // the same event to a caller, so both surface as SuperBooksToolError.
      if (toolName) {
        throw new SuperBooksToolError(toolName, text, {
          rpcCode: message.error.code,
          data: message.error.data,
        });
      }
      throw new SuperBooksError(text, {
        code: "protocol_error",
        rpcCode: message.error.code,
      });
    }
    return message.result as T;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    // A notification has no reply; drain the body so the socket can be reused.
    await response.text().catch(() => "");
  }

  /** Runs the MCP handshake once, even under concurrent first calls. */
  async ensureInitialized(): Promise<void> {
    this.initializing ??= (async () => {
      try {
        await this.rawRequest("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        });
        await this.notify("notifications/initialized");
      } catch (err) {
        // A failed handshake must not poison the client forever — a retry
        // after fixing the key should be able to start over.
        this.initializing = undefined;
        throw err;
      }
    })();

    return this.initializing;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.request<{ tools?: ToolDefinition[] }>("tools/list");
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = await this.request<{
      content?: ContentBlock[];
      structuredContent?: unknown;
      isError?: boolean;
    }>("tools/call", { name, arguments: args }, name);

    const content = Array.isArray(result?.content) ? result.content : [];
    return {
      data: extractData(result?.structuredContent, content),
      content,
      isError: result?.isError === true,
    };
  }
}

/**
 * Picks the most useful representation of a tool result.
 *
 * `structuredContent` wins when present. Otherwise the first text block is
 * parsed as JSON, which is what every SuperBooks tool actually returns. When
 * neither applies the caller still has `content`, so this returns null rather
 * than inventing a shape.
 */
function extractData(structuredContent: unknown, content: ContentBlock[]): unknown {
  if (structuredContent !== undefined && structuredContent !== null) return structuredContent;

  for (const block of content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      try {
        return JSON.parse((block as { text: string }).text) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}
