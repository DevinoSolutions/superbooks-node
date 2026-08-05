import { McpTransport, type TransportOptions } from "./transport.js";
import { SuperBooksError, SuperBooksToolError } from "./errors.js";
import type { ToolCaller, ToolDefinition, ToolResult } from "./types.js";
import {
  BankAccountsNamespace,
  CategoriesNamespace,
  CustomersNamespace,
  DocumentsNamespace,
  InboxNamespace,
  InvoicesNamespace,
  ReportsNamespace,
  SearchNamespace,
  TagsNamespace,
  TeamNamespace,
  TrackerNamespace,
  TransactionsNamespace,
} from "./generated/index.js";

export const DEFAULT_BASE_URL = "https://api.superbooks.io";

export interface SuperBooksOptions extends Omit<TransportOptions, "baseUrl" | "apiKey"> {
  /**
   * Team API key (`sb_…`) or OAuth access token. Falls back to the
   * `SUPERBOOKS_API_KEY` environment variable.
   */
  apiKey?: string;
  /** Defaults to `https://api.superbooks.io`. */
  baseUrl?: string;
  /**
   * Throw {@link SuperBooksToolError} when a tool reports `isError`.
   * Default true. Set false to inspect `result.isError` yourself.
   */
  throwOnToolError?: boolean;
}

/** Escape hatch for tools this SDK version does not yet know about. */
export class ToolsNamespace {
  readonly #transport: McpTransport;
  readonly #caller: ToolCaller;

  constructor(transport: McpTransport, caller: ToolCaller) {
    this.#transport = transport;
    this.#caller = caller;
  }

  /** Tools the endpoint exposes to *this* credential, after scope filtering. */
  list(): Promise<ToolDefinition[]> {
    return this.#transport.listTools();
  }

  /** Calls any tool by its wire name. */
  call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.#caller.callTool(name, args);
  }
}

/**
 * SuperBooks API client.
 *
 * ```ts
 * const sb = new SuperBooks({ apiKey: process.env.SUPERBOOKS_API_KEY });
 * const { data } = await sb.invoices.list({ status: "unpaid" });
 * ```
 */
export class SuperBooks implements ToolCaller {
  readonly transport: McpTransport;
  readonly #throwOnToolError: boolean;

  readonly transactions: TransactionsNamespace;
  readonly invoices: InvoicesNamespace;
  readonly customers: CustomersNamespace;
  readonly categories: CategoriesNamespace;
  readonly tags: TagsNamespace;
  readonly documents: DocumentsNamespace;
  readonly inbox: InboxNamespace;
  readonly tracker: TrackerNamespace;
  readonly bankAccounts: BankAccountsNamespace;
  readonly team: TeamNamespace;
  readonly search: SearchNamespace;
  readonly reports: ReportsNamespace;
  readonly tools: ToolsNamespace;

  constructor(options: SuperBooksOptions = {}) {
    const apiKey = options.apiKey ?? process.env["SUPERBOOKS_API_KEY"];
    if (!apiKey) {
      throw new SuperBooksError(
        "Missing API key. Pass `new SuperBooks({ apiKey })` or set SUPERBOOKS_API_KEY.",
        { code: "unauthorized" },
      );
    }

    const { apiKey: _ignored, baseUrl, throwOnToolError, ...transportOptions } = options;
    this.#throwOnToolError = throwOnToolError ?? true;
    this.transport = new McpTransport({
      ...transportOptions,
      apiKey,
      baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    });

    this.transactions = new TransactionsNamespace(this);
    this.invoices = new InvoicesNamespace(this);
    this.customers = new CustomersNamespace(this);
    this.categories = new CategoriesNamespace(this);
    this.tags = new TagsNamespace(this);
    this.documents = new DocumentsNamespace(this);
    this.inbox = new InboxNamespace(this);
    this.tracker = new TrackerNamespace(this);
    this.bankAccounts = new BankAccountsNamespace(this);
    this.team = new TeamNamespace(this);
    this.search = new SearchNamespace(this);
    this.reports = new ReportsNamespace(this);
    this.tools = new ToolsNamespace(this.transport, this);
  }

  /**
   * Invokes a tool. Every generated namespace method routes through here, so
   * this is the single place that error handling and argument scrubbing live.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    // Undefined values are dropped rather than serialized as `null`, which the
    // schemas treat as a meaningful "clear this field" for nullable inputs.
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) cleaned[key] = value;
    }

    const result = await this.transport.callTool(name, cleaned);

    if (result.isError && this.#throwOnToolError) {
      throw new SuperBooksToolError(name, toolErrorMessage(name, result), { data: result.data });
    }
    return result;
  }
}

function toolErrorMessage(name: string, result: ToolResult): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      const text = (block as { text: string }).text.trim();
      if (text) return text;
    }
  }
  return `Tool "${name}" reported an error`;
}
