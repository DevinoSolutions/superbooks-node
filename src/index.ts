export { SuperBooks, ToolsNamespace, DEFAULT_BASE_URL } from "./client.js";
export type { SuperBooksOptions } from "./client.js";

export { McpTransport, MCP_PROTOCOL_VERSION, parseSseMessages } from "./transport.js";
export type { TransportOptions } from "./transport.js";

export {
  SuperBooksError,
  SuperBooksAuthError,
  SuperBooksPermissionError,
  SuperBooksRateLimitError,
  SuperBooksConnectionError,
  SuperBooksProtocolError,
  SuperBooksToolError,
} from "./errors.js";
export type { SuperBooksErrorCode } from "./errors.js";

export type {
  ContentBlock,
  TextContentBlock,
  UnknownContentBlock,
  ToolCaller,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export { VERSION } from "./version.js";

// Generated: namespace classes, per-tool parameter types, tool-name constants.
export * from "./generated/index.js";
