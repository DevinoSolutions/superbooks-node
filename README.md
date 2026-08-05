# superbooks

Official SuperBooks SDK for Node.js and TypeScript.

A typed client for the SuperBooks API — 45 operations covering transactions, invoices, customers,
documents, time tracking, and reports, exposed as per-domain methods like
`sb.invoices.list({ status: "unpaid" })`.

The API is served over [MCP](https://modelcontextprotocol.io) at `https://api.superbooks.io`, which
this package wraps for you. If you want to point an AI client at SuperBooks rather than write code
against it, connect it to that endpoint directly — see [Using SuperBooks from an AI
client](#using-superbooks-from-an-ai-client).

Zero runtime dependencies. ESM and CommonJS. Node 20+.

## Install

```sh
npm install superbooks
```

## Quickstart

```ts
import { SuperBooks } from "superbooks";

const sb = new SuperBooks({ apiKey: process.env.SUPERBOOKS_API_KEY });

const { data } = await sb.invoices.list({ status: "unpaid", limit: 10 });
console.log(data);

await sb.tags.create({ name: "q3-audit" });

const runway = await sb.reports.runway();
console.log(runway.data);
```

Every method returns a `ToolResult`:

```ts
interface ToolResult {
  data: unknown; // parsed JSON payload — the field you normally want
  content: ContentBlock[]; // raw MCP content blocks
  isError: boolean;
}
```

`data` is typed `unknown` deliberately. Argument types are generated from the published tool schemas
and are therefore guaranteed; result shapes are not part of that contract, so the SDK does not claim
a type the server has never promised. Narrow it yourself:

```ts
const { data } = await sb.customers.list({ limit: 5 });
const { items } = data as { items: Array<{ id: string; name: string }> };
```

## Authentication

Mint a team API key at [app.superbooks.io](https://app.superbooks.io) under **Settings → Developer**.
Keys are prefixed `sb_`. There is no separate test-mode key — a key is either live or revoked.

```ts
new SuperBooks({ apiKey: "sb_your_api_key_here" });
```

The key falls back to the `SUPERBOOKS_API_KEY` environment variable when not passed explicitly. The
SDK sends it as `Authorization: Bearer <key>`; the endpoint also accepts an `x-api-key` header, and
the same bearer slot accepts an OAuth access token if you have gone through the OAuth flow instead.

### Scopes

A key's scopes are fixed when you mint it. Scopes are either the meta-scopes `apis.all` (full
access) and `apis.read` (read-only), or fine-grained `<resource>.<read|write>` entries such as
`invoices.write`.

The endpoint only advertises the tools your credential can reach, so `sb.tools.list()` returns
exactly what you are allowed to call — it is the reliable way to see your effective access.

Destructive tools (`transactions_delete`, `invoices_void`, `customers_delete`, `categories_delete`,
`tags_delete`, `documents_delete`, `inbox_delete`, `tracker_delete_entry`) sit behind **two** gates:

1. the credential must carry `apis.all` — no fine-grained scope grants destructive access, and
   neither does `apis.read`; and
2. the team must have destructive AI tools enabled in settings.

If either gate is closed the tool is not exposed at all — a credential cannot reach them unless your
team has also enabled destructive AI tools. `DESTRUCTIVE_TOOL_NAMES` is exported if you want to guard
against them in your own code.

## Errors

```ts
import {
  SuperBooksError,
  SuperBooksAuthError,
  SuperBooksPermissionError,
  SuperBooksRateLimitError,
  SuperBooksToolError,
} from "superbooks";

try {
  await sb.invoices.send({ id: invoiceId });
} catch (err) {
  if (err instanceof SuperBooksRateLimitError) {
    console.log(`retry in ${err.retryAfterSeconds}s`);
  } else if (err instanceof SuperBooksAuthError) {
    // 401 — key missing, malformed, or revoked
  } else if (err instanceof SuperBooksPermissionError) {
    // 403 — scope or team setting does not allow this
  } else if (err instanceof SuperBooksToolError) {
    // the call reached the tool, and the tool refused
    console.log(err.toolName, err.message);
  }
}
```

Everything derives from `SuperBooksError`, which carries `status` and `code`.

### Retries

The client retries **rate-limited (429) requests only**, twice by default, honouring `Retry-After`
(capped at 60s).

5xx responses are deliberately **not** retried. A tool call is not guaranteed idempotent — a 500 from
`invoices_send` may mean the email already went out — so replaying it is the caller's decision, not
the SDK's. Tune with `maxRetries`, `maxRetryDelaySeconds`, and `timeoutMs`:

```ts
new SuperBooks({ apiKey, maxRetries: 0, timeoutMs: 15_000 });
```

## Namespaces

| Namespace         | Tools                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `sb.transactions` | `list` `get` `updateStatus` `updateCategory` `delete`                                              |
| `sb.invoices`     | `list` `get` `createDraft` `send` `void`                                                           |
| `sb.customers`    | `list` `get` `create` `update` `delete`                                                            |
| `sb.categories`   | `list` `create` `update` `delete`                                                                  |
| `sb.tags`         | `list` `create` `delete`                                                                           |
| `sb.documents`    | `list` `get` `search` `delete`                                                                     |
| `sb.inbox`        | `list` `match` `delete`                                                                            |
| `sb.tracker`      | `listProjects` `listEntries` `startTimer` `stopTimer` `deleteEntry`                                |
| `sb.bankAccounts` | `list`                                                                                             |
| `sb.team`         | `get`                                                                                              |
| `sb.search`       | `global`                                                                                           |
| `sb.reports`      | `burnRate` `runway` `profitLoss` `revenue` `spending` `balance` `topCustomers` `recurringExpenses` |

### Escape hatches

```ts
await sb.tools.list(); // tools this credential can reach
await sb.tools.call("some_new_tool", { foo: 1 }); // call anything by wire name
```

## Using SuperBooks from an AI client

This package is for writing code. If instead you want an AI client to call SuperBooks as a tool
provider, connect it straight to the hosted server at `https://api.superbooks.io/mcp` — no
installation required, and it supports the OAuth sign-in flow.

**claude.ai / Claude Desktop connectors**, and **Claude Code**:

```sh
claude mcp add --transport http superbooks https://api.superbooks.io/mcp \
  --header "Authorization: Bearer sb_your_api_key_here"
```

Other clients accept the same endpoint wherever they take a remote MCP server URL. See the
[SuperBooks docs](https://superbooks.io/docs) for per-client setup.

## How the typed surface is generated

`sdk-manifest.json` holds the published tool surface — names, descriptions, and input JSON Schemas,
exactly as `tools/list` returns them. `scripts/codegen.ts` turns it into `src/generated/`, and CI
fails if the two drift apart. To regenerate:

```sh
npm run codegen
```

Because the manifest is committed, building this package never needs the SuperBooks backend.

## License

MIT
