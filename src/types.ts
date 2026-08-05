/** Shared shapes used by both the hand-written client and the generated code. */

/** A block of MCP tool output. Text blocks are by far the common case. */
export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface UnknownContentBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock = TextContentBlock | UnknownContentBlock;

/**
 * The result of a tool call.
 *
 * `data` is the useful field. SuperBooks tools return JSON, so `data` holds
 * the parsed object: taken from `structuredContent` when the server sends it,
 * otherwise parsed out of the first text block. It is `null` only when the
 * tool returned something that is not JSON — in which case `content` still
 * carries the raw blocks verbatim.
 *
 * `data` is typed `unknown` on purpose: the SDK generates argument types from
 * the published tool schemas, but result shapes are not part of that contract
 * and asserting one would be a promise the server has not made. Narrow it
 * yourself, ideally with a validator.
 */
export interface ToolResult {
  data: unknown;
  content: ContentBlock[];
  /** True when the tool reported a failure without raising a JSON-RPC error. */
  isError: boolean;
}

/** What a generated namespace needs in order to invoke a tool. */
export interface ToolCaller {
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/** One entry of a `tools/list` response. */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}
