import { describe, expect, it } from "vitest";
import { McpTransport, parseSseMessages } from "../src/transport.js";
import {
  SuperBooksAuthError,
  SuperBooksConnectionError,
  SuperBooksError,
  SuperBooksPermissionError,
  SuperBooksProtocolError,
  SuperBooksRateLimitError,
  SuperBooksToolError,
} from "../src/errors.js";
import { FAKE_API_KEY, createMockFetch, sseFrame, textResult } from "./helpers.js";

const make = (mockFetch: typeof globalThis.fetch, options = {}) =>
  new McpTransport({
    baseUrl: "https://api.superbooks.io",
    apiKey: FAKE_API_KEY,
    fetch: mockFetch,
    maxRetries: 0,
    ...options,
  });

describe("endpoint resolution", () => {
  it("appends /mcp to a bare origin", () => {
    expect(make(createMockFetch(() => undefined).fetch).url).toBe("https://api.superbooks.io/mcp");
  });

  it("does not double up when the base URL already ends in /mcp", () => {
    const transport = make(createMockFetch(() => undefined).fetch, {
      baseUrl: "https://api.superbooks.io/mcp",
    });
    expect(transport.url).toBe("https://api.superbooks.io/mcp");
  });

  it("tolerates a trailing slash", () => {
    const transport = make(createMockFetch(() => undefined).fetch, {
      baseUrl: "https://api.superbooks.io/",
    });
    expect(transport.url).toBe("https://api.superbooks.io/mcp");
  });
});

describe("auth header formation", () => {
  it("sends the key as a bearer token", async () => {
    const mock = createMockFetch(() => undefined);
    await make(mock.fetch).listTools();

    for (const call of mock.calls) {
      expect(call.headers["authorization"]).toBe(`Bearer ${FAKE_API_KEY}`);
    }
  });

  it("sends the MCP content negotiation and protocol headers", async () => {
    const mock = createMockFetch(() => undefined);
    await make(mock.fetch).listTools();

    const first = mock.calls[0]!;
    expect(first.method).toBe("POST");
    expect(first.headers["content-type"]).toBe("application/json");
    expect(first.headers["accept"]).toBe("application/json, text/event-stream");
    expect(first.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("merges custom headers but never lets them override Authorization", async () => {
    const mock = createMockFetch(() => undefined);
    const transport = make(mock.fetch, {
      headers: { "X-Trace": "abc", Authorization: "Bearer attacker-supplied" },
    });
    await transport.listTools();

    const first = mock.calls[0]!;
    expect(first.headers["x-trace"]).toBe("abc");
    expect(first.headers["authorization"]).toBe(`Bearer ${FAKE_API_KEY}`);
  });

  // Header names are case-insensitive on the wire but distinct as object keys,
  // so a lower-cased override would survive a naive spread and reach fetch
  // beside ours — Headers would then join both into one value.
  it.each(["authorization", "AUTHORIZATION", "AuThOrIzAtIoN"])(
    "strips a caller-supplied %s header in any case",
    async (name) => {
      const mock = createMockFetch(() => undefined);
      await make(mock.fetch, {
        headers: { [name]: "Bearer attacker-supplied", "X-Trace": "abc" },
      }).listTools();

      const first = mock.calls[0]!;
      const authKeys = first.rawHeaderKeys.filter((k) => k.toLowerCase() === "authorization");
      expect(authKeys).toEqual(["Authorization"]);
      expect(first.headers["authorization"]).toBe(`Bearer ${FAKE_API_KEY}`);
      expect(first.headers["authorization"]).not.toContain("attacker-supplied");
      // Unrelated custom headers still come through.
      expect(first.headers["x-trace"]).toBe("abc");
    },
  );

  it("does not mutate the caller's headers object, nor read later changes to it", async () => {
    const mock = createMockFetch(() => undefined);
    const supplied: Record<string, string> = { "X-Trace": "abc" };
    const transport = make(mock.fetch, { headers: supplied });

    supplied["authorization"] = "Bearer sneaked-in-later";
    await transport.listTools();

    expect(mock.calls[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(supplied["X-Trace"]).toBe("abc");
  });

  it("echoes the session id the server assigned during initialize", async () => {
    const mock = createMockFetch(() => undefined);
    await make(mock.fetch).listTools();

    // The handshake itself cannot know the id yet; every later call must.
    expect(mock.calls[0]!.headers["mcp-session-id"]).toBeUndefined();
    expect(mock.calls.at(-1)!.headers["mcp-session-id"]).toBe("test-session-1");
  });
});

describe("handshake", () => {
  it("initializes once, then sends the initialized notification, then the request", async () => {
    const mock = createMockFetch(() => undefined);
    const transport = make(mock.fetch);

    await transport.listTools();
    await transport.listTools();

    expect(mock.calls.map((c) => c.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
    ]);
  });

  it("does not initialize twice under concurrent first calls", async () => {
    const mock = createMockFetch(() => undefined);
    const transport = make(mock.fetch);

    await Promise.all([transport.listTools(), transport.listTools(), transport.listTools()]);

    expect(mock.calls.filter((c) => c.body.method === "initialize")).toHaveLength(1);
  });

  it("allows a retry after a failed handshake instead of caching the failure", async () => {
    let attempt = 0;
    const mock = createMockFetch((request) => {
      if (request.method === "initialize" && attempt++ === 0) {
        return { status: 401, text: "Unauthorized" };
      }
      return undefined;
    });
    const transport = make(mock.fetch);

    await expect(transport.listTools()).rejects.toThrow(SuperBooksAuthError);
    await expect(transport.listTools()).resolves.toEqual([]);
  });
});

describe("response decoding", () => {
  it("reads a plain JSON response", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? { json: { jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "tags_list" }] } } }
        : undefined,
    );

    await expect(make(mock.fetch).listTools()).resolves.toEqual([{ name: "tags_list" }]);
  });

  it("reads a response delivered as server-sent events", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? {
            headers: { "content-type": "text/event-stream" },
            text:
              ": keep-alive\n\n" +
              sseFrame({
                jsonrpc: "2.0",
                id: request.id,
                result: { tools: [{ name: "team_get" }] },
              }),
          }
        : undefined,
    );

    await expect(make(mock.fetch).listTools()).resolves.toEqual([{ name: "team_get" }]);
  });

  it("raises a protocol error when the body is not JSON", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list" ? { text: "<html>gateway</html>" } : undefined,
    );

    await expect(make(mock.fetch).listTools()).rejects.toThrow(SuperBooksProtocolError);
  });

  it("raises a protocol error when no message matches the request id", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? { json: { jsonrpc: "2.0", id: 999, result: { tools: [] } } }
        : undefined,
    );

    await expect(make(mock.fetch).listTools()).rejects.toThrow(/No JSON-RPC response with id/);
  });

  it("raises a JSON-RPC error on a tool call as SuperBooksToolError with rpcCode", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32602,
                message: "Invalid params: id must be a uuid",
                data: { field: "id" },
              },
            },
          }
        : undefined,
    );

    const err = await make(mock.fetch)
      .callTool("tags_delete", { id: "nope" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SuperBooksToolError);
    expect((err as SuperBooksToolError).toolName).toBe("tags_delete");
    expect((err as SuperBooksToolError).rpcCode).toBe(-32602);
    expect((err as SuperBooksToolError).data).toEqual({ field: "id" });
    expect((err as SuperBooksToolError).message).toContain("must be a uuid");
  });

  it("keeps rpcCode on a JSON-RPC error from a non-tool method", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            },
          }
        : undefined,
    );

    const err = await make(mock.fetch)
      .listTools()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SuperBooksError);
    expect(err).not.toBeInstanceOf(SuperBooksToolError);
    expect((err as SuperBooksError).rpcCode).toBe(-32601);
  });

  it("surfaces a JSON-RPC error as a SuperBooksError", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            },
          }
        : undefined,
    );

    await expect(make(mock.fetch).listTools()).rejects.toThrow("Method not found");
  });
});

describe("parseSseMessages", () => {
  it("ignores comments and keep-alives, and joins multi-line data", () => {
    const body = [
      ": comment",
      "",
      'data: {"a":1}',
      "",
      "data: {",
      'data: "b": 2}',
      "",
      "data: not-json",
      "",
    ].join("\n");

    expect(parseSseMessages(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles CRLF line endings", () => {
    expect(parseSseMessages('data: {"ok":true}\r\n\r\n')).toEqual([{ ok: true }]);
  });
});

describe("tool results", () => {
  it("parses JSON out of a text content block", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call"
        ? textResult(request.id, { items: [{ id: "1", name: "urgent" }] })
        : undefined,
    );

    const result = await make(mock.fetch).callTool("tags_list", {});
    expect(result.data).toEqual({ items: [{ id: "1", name: "urgent" }] });
    expect(result.isError).toBe(false);
  });

  it("prefers structuredContent when the server provides it", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                content: [{ type: "text", text: '{"stale":true}' }],
                structuredContent: { fresh: true },
              },
            },
          }
        : undefined,
    );

    expect((await make(mock.fetch).callTool("team_get")).data).toEqual({ fresh: true });
  });

  it("keeps raw content and reports null data when the text is not JSON", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              result: { content: [{ type: "text", text: "plain prose" }] },
            },
          }
        : undefined,
    );

    const result = await make(mock.fetch).callTool("team_get");
    expect(result.data).toBeNull();
    expect(result.content).toEqual([{ type: "text", text: "plain prose" }]);
  });

  it("sends the tool name and arguments in MCP's params shape", async () => {
    const mock = createMockFetch(() => undefined);
    await make(mock.fetch).callTool("tags_create", { name: "urgent" });

    const call = mock.calls.find((c) => c.body.method === "tools/call")!;
    expect(call.body.params).toEqual({ name: "tags_create", arguments: { name: "urgent" } });
  });
});

describe("error mapping", () => {
  const statusCase = async (status: number, headers: Record<string, string> = {}, body = "") => {
    const mock = createMockFetch((request) =>
      request.method === "initialize" ? undefined : { status, headers, text: body },
    );
    return make(mock.fetch)
      .listTools()
      .catch((err: unknown) => err);
  };

  it("maps 401 to SuperBooksAuthError", async () => {
    const err = await statusCase(401);
    expect(err).toBeInstanceOf(SuperBooksAuthError);
    expect((err as SuperBooksAuthError).code).toBe("unauthorized");
    expect((err as SuperBooksAuthError).status).toBe(401);
  });

  it("maps 403 to SuperBooksPermissionError", async () => {
    const err = await statusCase(403);
    expect(err).toBeInstanceOf(SuperBooksPermissionError);
    expect((err as SuperBooksPermissionError).code).toBe("forbidden");
  });

  it("maps 429 to SuperBooksRateLimitError and parses Retry-After", async () => {
    const err = await statusCase(429, { "retry-after": "42" });
    expect(err).toBeInstanceOf(SuperBooksRateLimitError);
    expect((err as SuperBooksRateLimitError).retryAfterSeconds).toBe(42);
  });

  it("leaves retryAfterSeconds undefined when the header is absent or junk", async () => {
    expect(((await statusCase(429)) as SuperBooksRateLimitError).retryAfterSeconds).toBeUndefined();
    expect(
      ((await statusCase(429, { "retry-after": "soon" })) as SuperBooksRateLimitError)
        .retryAfterSeconds,
    ).toBeUndefined();
  });

  it("classifies 5xx as a server error and 4xx as a bad request", async () => {
    expect(((await statusCase(503)) as SuperBooksError).code).toBe("server_error");
    expect(((await statusCase(400)) as SuperBooksError).code).toBe("bad_request");
  });

  it("includes a short response body in the message but not a long one", async () => {
    expect(((await statusCase(400, {}, "team is required")) as Error).message).toContain(
      "team is required",
    );
    expect(((await statusCase(400, {}, "x".repeat(5000))) as Error).message).not.toContain("xxxx");
  });

  it("wraps a network failure as SuperBooksConnectionError", async () => {
    const failing = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await expect(make(failing).listTools()).rejects.toThrow(SuperBooksConnectionError);
  });

  it("reports a timeout as a connection error naming the budget", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    await expect(make(hanging, { timeoutMs: 10 }).listTools()).rejects.toThrow(/timed out/);
  });
});

describe("rate limit retries", () => {
  it("retries a 429 up to maxRetries and then succeeds", async () => {
    let hits = 0;
    const mock = createMockFetch((request) => {
      if (request.method !== "tools/list") return undefined;
      if (hits++ < 2) return { status: 429, headers: { "retry-after": "0" }, text: "slow down" };
      return { json: { jsonrpc: "2.0", id: request.id, result: { tools: [] } } };
    });

    await expect(make(mock.fetch, { maxRetries: 2 }).listTools()).resolves.toEqual([]);
    expect(hits).toBe(3);
  });

  it("gives up once maxRetries is exhausted", async () => {
    let hits = 0;
    const mock = createMockFetch((request) => {
      if (request.method !== "tools/list") return undefined;
      hits++;
      return { status: 429, headers: { "retry-after": "0" }, text: "slow down" };
    });

    await expect(make(mock.fetch, { maxRetries: 1 }).listTools()).rejects.toThrow(
      SuperBooksRateLimitError,
    );
    expect(hits).toBe(2);
  });

  it("does NOT retry a 5xx, because tool calls are not idempotent", async () => {
    let hits = 0;
    const mock = createMockFetch((request) => {
      if (request.method !== "tools/call") return undefined;
      hits++;
      return { status: 500, text: "boom" };
    });

    await expect(
      make(mock.fetch, { maxRetries: 3 }).callTool("invoices_send", { id: "x" }),
    ).rejects.toThrow(SuperBooksError);
    expect(hits).toBe(1);
  });

  it("caps an outsized Retry-After rather than sleeping for it", async () => {
    let hits = 0;
    const started = Date.now();
    const mock = createMockFetch((request) => {
      if (request.method !== "tools/list") return undefined;
      if (hits++ === 0) return { status: 429, headers: { "retry-after": "86400" }, text: "" };
      return { json: { jsonrpc: "2.0", id: request.id, result: { tools: [] } } };
    });

    await make(mock.fetch, { maxRetries: 1, maxRetryDelaySeconds: 0 }).listTools();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
