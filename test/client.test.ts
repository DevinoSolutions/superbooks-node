import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SuperBooks } from "../src/client.js";
import { SuperBooksError, SuperBooksToolError } from "../src/errors.js";
import { ALL_TOOL_NAMES, DESTRUCTIVE_TOOL_NAMES } from "../src/generated/index.js";
import { FAKE_API_KEY, createMockFetch, textResult } from "./helpers.js";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "sdk-manifest.json"), "utf8")) as {
  toolCount: number;
  domains: Record<string, { name: string; destructive: boolean }[]>;
};

const client = (mockFetch: typeof globalThis.fetch, options = {}) =>
  new SuperBooks({ apiKey: FAKE_API_KEY, fetch: mockFetch, maxRetries: 0, ...options });

describe("construction", () => {
  it("requires an API key", () => {
    const saved = process.env["SUPERBOOKS_API_KEY"];
    delete process.env["SUPERBOOKS_API_KEY"];
    try {
      expect(() => new SuperBooks()).toThrow(SuperBooksError);
      expect(() => new SuperBooks()).toThrow(/SUPERBOOKS_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["SUPERBOOKS_API_KEY"] = saved;
    }
  });

  it("falls back to SUPERBOOKS_API_KEY", () => {
    const saved = process.env["SUPERBOOKS_API_KEY"];
    process.env["SUPERBOOKS_API_KEY"] = FAKE_API_KEY;
    try {
      expect(() => new SuperBooks()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env["SUPERBOOKS_API_KEY"];
      else process.env["SUPERBOOKS_API_KEY"] = saved;
    }
  });

  it("defaults to the public endpoint", () => {
    expect(client(createMockFetch(() => undefined).fetch).transport.url).toBe(
      "https://api.superbooks.io/mcp",
    );
  });
});

describe("namespace coverage", () => {
  // Guards the one hand-written seam in an otherwise generated surface: adding
  // a domain to the manifest must not silently skip wiring it onto the client.
  it("exposes a namespace for every domain in the manifest", () => {
    const sb = client(createMockFetch(() => undefined).fetch) as unknown as Record<string, unknown>;

    for (const domain of Object.keys(manifest.domains)) {
      const property = domain.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
      expect(sb[property], `missing namespace: sb.${property}`).toBeDefined();
    }
  });

  it("exposes a method for every tool, bound to the right wire name", async () => {
    const seen: string[] = [];
    const mock = createMockFetch((request) => {
      if (request.method === "tools/call") {
        seen.push((request.params as { name: string }).name);
      }
      return undefined;
    });
    const sb = client(mock.fetch) as unknown as Record<string, Record<string, Function>>;

    for (const [domain, tools] of Object.entries(manifest.domains)) {
      const property = domain.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
      for (const tool of tools) {
        const method = tool.name
          .slice(domain.length + 1)
          .replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
        const fn = sb[property]?.[method];
        expect(typeof fn, `sb.${property}.${method} should be a function`).toBe("function");
        await fn!.call(sb[property], {});
      }
    }

    expect(seen.sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(seen).toHaveLength(manifest.toolCount);
  });

  it("agrees with the manifest on which tools are destructive", () => {
    const expected = Object.values(manifest.domains)
      .flat()
      .filter((t) => t.destructive)
      .map((t) => t.name);

    expect([...DESTRUCTIVE_TOOL_NAMES].sort()).toEqual(expected.sort());
  });
});

describe("argument handling", () => {
  it("drops undefined values so they are not sent as null", async () => {
    const mock = createMockFetch(() => undefined);
    await client(mock.fetch).customers.list({ name: "acme", cursor: undefined, limit: 10 });

    const call = mock.calls.find((c) => c.body.method === "tools/call")!;
    expect((call.body.params as { arguments: unknown }).arguments).toEqual({
      name: "acme",
      limit: 10,
    });
  });

  it("keeps an explicit null, which nullable fields treat as 'clear this'", async () => {
    const mock = createMockFetch(() => undefined);
    // `phone` is nullable in the schema; `name` is merely optional, and the
    // types enforce that distinction at the call site.
    await client(mock.fetch).customers.update({ id: "c1", phone: null });

    const call = mock.calls.find((c) => c.body.method === "tools/call")!;
    expect(
      (call.body.params as { arguments: Record<string, unknown> }).arguments["phone"],
    ).toBeNull();
  });

  it("sends an empty object for tools that take no arguments", async () => {
    const mock = createMockFetch(() => undefined);
    await client(mock.fetch).team.get();

    const call = mock.calls.find((c) => c.body.method === "tools/call")!;
    expect(call.body.params).toEqual({ name: "team_get", arguments: {} });
  });
});

describe("tool errors", () => {
  const errorFetch = () =>
    createMockFetch((request) =>
      request.method === "tools/call"
        ? textResult(request.id, { message: "Invoice is not a draft" }, true)
        : undefined,
    );

  it("throws SuperBooksToolError by default, carrying the tool name", async () => {
    const err = await client(errorFetch().fetch)
      .invoices.send({ id: "inv_1" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SuperBooksToolError);
    expect((err as SuperBooksToolError).toolName).toBe("invoices_send");
    expect((err as SuperBooksToolError).code).toBe("tool_error");
    expect((err as SuperBooksToolError).message).toContain("Invoice is not a draft");
  });

  it("returns the result instead when throwOnToolError is false", async () => {
    const result = await client(errorFetch().fetch, { throwOnToolError: false }).invoices.send({
      id: "inv_1",
    });

    expect(result.isError).toBe(true);
    expect(result.data).toEqual({ message: "Invoice is not a draft" });
  });

  it("does not throw for a successful result", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call" ? textResult(request.id, { items: [] }) : undefined,
    );

    await expect(client(mock.fetch).transactions.list({})).resolves.toMatchObject({
      isError: false,
      data: { items: [] },
    });
  });
});

describe("escape hatches", () => {
  it("tools.list passes through the server's tool definitions", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/list"
        ? {
            json: {
              jsonrpc: "2.0",
              id: request.id,
              result: { tools: [{ name: "tags_list", description: "List tags" }] },
            },
          }
        : undefined,
    );

    await expect(client(mock.fetch).tools.list()).resolves.toEqual([
      { name: "tags_list", description: "List tags" },
    ]);
  });

  it("tools.call reaches a tool the SDK does not know about", async () => {
    const mock = createMockFetch((request) =>
      request.method === "tools/call" ? textResult(request.id, { ok: true }) : undefined,
    );

    const result = await client(mock.fetch).tools.call("some_future_tool", { x: 1 });
    expect(result.data).toEqual({ ok: true });

    const call = mock.calls.find((c) => c.body.method === "tools/call")!;
    expect(call.body.params).toEqual({ name: "some_future_tool", arguments: { x: 1 } });
  });
});
