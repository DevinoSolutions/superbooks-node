/**
 * Test doubles for the HTTP layer.
 *
 * Nothing in the suite touches the network. Every test drives a fake `fetch`,
 * so there is no live endpoint and no credential anywhere — the keys below are
 * obviously fake placeholders.
 */

export const FAKE_API_KEY = "sb_not_a_real_key";

export interface RecordedCall {
  url: string;
  method: string;
  /** Lower-cased for convenient lookup. */
  headers: Record<string, string>;
  /**
   * Header keys exactly as the transport built them. Lower-casing collapses
   * `Authorization` and `authorization` into one entry, which would hide a
   * duplicate-credential bug, so the raw keys are kept for assertions.
   */
  rawHeaderKeys: string[];
  body: JsonRpcRequest;
}

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: unknown;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Body as a JSON-RPC result object, or a raw string for protocol tests. */
  json?: unknown;
  text?: string;
}

export interface MockFetch {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  /** Calls that carried a JSON-RPC id, i.e. requests rather than notifications. */
  requests: RecordedCall[];
}

/**
 * Builds a fake fetch.
 *
 * `handler` sees each decoded JSON-RPC message and returns what the server
 * should reply. Returning `undefined` falls back to a generic empty result,
 * which keeps the MCP handshake out of tests that do not care about it.
 */
export function createMockFetch(
  handler: (request: JsonRpcRequest, call: RecordedCall) => MockResponse | undefined,
): MockFetch {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as JsonRpcRequest;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    const call: RecordedCall = {
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      rawHeaderKeys: Object.keys((init?.headers ?? {}) as Record<string, string>),
      body,
    };
    calls.push(call);

    const spec = handler(body, call) ?? defaultResponse(body);
    const responseBody =
      spec.text !== undefined
        ? spec.text
        : JSON.stringify(
            spec.json !== undefined ? spec.json : { jsonrpc: "2.0", id: body.id, result: {} },
          );

    return new Response(responseBody, {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    calls,
    get requests() {
      return calls.filter((c) => c.body.id !== undefined);
    },
  };
}

function defaultResponse(request: JsonRpcRequest): MockResponse {
  if (request.method === "initialize") {
    return {
      headers: { "mcp-session-id": "test-session-1" },
      json: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "superbooks", version: "1.0.0" },
        },
      },
    };
  }
  return { json: { jsonrpc: "2.0", id: request.id, result: {} } };
}

/** Wraps a JSON-RPC message in a minimal SSE frame. */
export function sseFrame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** A `tools/call` result carrying JSON in a text block, as the server sends it. */
export function textResult(
  id: number | undefined,
  payload: unknown,
  isError = false,
): MockResponse {
  return {
    json: {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(isError ? { isError: true } : {}),
      },
    },
  };
}
