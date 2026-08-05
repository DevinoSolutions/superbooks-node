/**
 * Generates `src/generated/` from `sdk-manifest.json`.
 *
 *   npm run codegen          # write the files
 *   npm run codegen:check    # fail if the files are stale (used by CI)
 *
 * The manifest is the published tool surface: names, descriptions, and input
 * JSON Schemas, exactly as `tools/list` returns them. It is produced by
 * `scripts/generate-manifest.mjs` and committed, so this script — and the
 * build — never need the SuperBooks backend.
 *
 * The emitter deliberately supports only the JSON Schema keywords the manifest
 * actually uses. Anything unrecognised becomes `unknown`, never `any`, so a
 * new construct shows up as a compile error at the call site instead of
 * silently disabling type checking.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "sdk-manifest.json");
const OUT_DIR = join(ROOT, "src", "generated");

const CHECK_MODE = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  [key: string]: unknown;
}

interface ManifestTool {
  name: string;
  description: string;
  scope: "read" | "write" | "destructive";
  destructive: boolean;
  inputSchema: JsonSchema;
}

interface Manifest {
  generatedAt: string;
  toolCount: number;
  domains: Record<string, ManifestTool[]>;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const camel = (s: string): string => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string): string => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** `transactions_update_status` in domain `transactions` -> `updateStatus`. */
function methodName(domain: string, toolName: string): string {
  if (!toolName.startsWith(`${domain}_`)) {
    throw new Error(`tool "${toolName}" does not start with its domain "${domain}_"`);
  }
  return camel(toolName.slice(domain.length + 1));
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propKey = (name: string): string => (IDENT_RE.test(name) ? name : JSON.stringify(name));

// ---------------------------------------------------------------------------
// JSON Schema -> TypeScript
// ---------------------------------------------------------------------------

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function scalarType(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function typeOf(schema: JsonSchema, indent: string): string {
  if (schema.const !== undefined) return literal(schema.const);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(literal).join(" | ");
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const parts = [...new Set(union.map((member) => typeOf(member, indent)))];
    return parts.length === 1 ? (parts[0] as string) : parts.join(" | ");
  }

  if (Array.isArray(schema.type)) {
    return [...new Set(schema.type.map(scalarType))].join(" | ");
  }

  if (schema.type === "array") {
    if (!schema.items) return "unknown[]";
    const inner = typeOf(schema.items, indent);
    return /[|&\s]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
  }

  if (schema.type === "object" || schema.properties) {
    return objectType(schema, indent);
  }

  if (typeof schema.type === "string") return scalarType(schema.type);

  return "unknown";
}

/** Renders an inline `{ … }` type. Depth in the manifest never exceeds 3. */
function objectType(schema: JsonSchema, indent: string): string {
  const properties = schema.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return "Record<string, unknown>";
  }

  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines: string[] = ["{"];

  for (const [name, property] of Object.entries(properties)) {
    lines.push(...docComment(property, inner));
    const optional = required.has(name) ? "" : "?";
    lines.push(`${inner}${propKey(name)}${optional}: ${typeOf(property, inner)};`);
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** Wraps text at ~76 columns so generated JSDoc stays readable. */
function wrap(text: string, width = 76): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function docComment(schema: JsonSchema, indent: string): string[] {
  const parts: string[] = [];
  if (schema.description) parts.push(schema.description);
  if (schema.default !== undefined) parts.push(`@defaultValue ${literal(schema.default)}`);
  if (parts.length === 0) return [];

  const lines = parts.flatMap((p) => wrap(p));
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`];
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

const BANNER = `// Generated by scripts/codegen.ts from sdk-manifest.json. Do not edit.
// Run \`npm run codegen\` to regenerate.
`;

function emitDomain(domain: string, tools: ManifestTool[]): string {
  const nsClass = `${pascal(domain)}Namespace`;
  const out: string[] = [BANNER, `import type { ToolCaller, ToolResult } from "../types.js";`, ""];

  // Params interfaces.
  for (const tool of tools) {
    const iface = `${pascal(tool.name)}Params`;
    const properties = tool.inputSchema.properties ?? {};

    if (Object.keys(properties).length === 0) {
      out.push(
        `/** \`${tool.name}\` takes no arguments. */`,
        `export type ${iface} = Record<string, never>;`,
        "",
      );
      continue;
    }

    // A type alias, not an interface: only aliases carry an implicit index
    // signature, which is what lets a params object be passed straight to
    // `callTool(name, Record<string, unknown>)` without a cast at every site.
    out.push(`export type ${iface} = ${objectType(tool.inputSchema, "")};`, "");
  }

  // Tool-name constants: the wire names, kept explicit so a rename in the
  // backend surfaces here rather than inside a method body.
  out.push(
    `/** Wire names of the \`${domain}\` tools, as returned by \`tools/list\`. */`,
    `export const ${domain.toUpperCase()}_TOOLS = {`,
  );
  for (const tool of tools) {
    out.push(`  ${methodName(domain, tool.name)}: ${JSON.stringify(tool.name)},`);
  }
  out.push(`} as const;`, "");

  // Namespace class.
  out.push(`export class ${nsClass} {`, `  readonly #caller: ToolCaller;`, "");
  out.push(`  constructor(caller: ToolCaller) {`, `    this.#caller = caller;`, `  }`);

  for (const tool of tools) {
    const method = methodName(domain, tool.name);
    const iface = `${pascal(tool.name)}Params`;
    const hasProperties = Object.keys(tool.inputSchema.properties ?? {}).length > 0;
    const requiredCount = (tool.inputSchema.required ?? []).length;
    const optionalParam = !hasProperties || requiredCount === 0;

    const doc = [tool.description];
    if (tool.destructive) {
      doc.push(
        "@remarks DESTRUCTIVE. Two gates guard it: your credential must carry the `apis.all` scope, and your team must have destructive AI tools enabled in team settings. If either is closed the tool is not exposed at all, so a credential alone cannot reach it.",
      );
    }

    out.push("");
    out.push(`  /**`);
    for (const line of doc.flatMap((d) => wrap(d))) out.push(`   * ${line}`);
    out.push(`   */`);
    out.push(
      `  ${method}(params${optionalParam ? "?" : ""}: ${iface}): Promise<ToolResult> {`,
      `    return this.#caller.callTool(${domain.toUpperCase()}_TOOLS.${method}, params${optionalParam ? " ?? {}" : ""});`,
      `  }`,
    );
  }

  out.push(`}`, "");
  return out.join("\n");
}

function emitIndex(manifest: Manifest): string {
  const domains = Object.keys(manifest.domains);
  const out: string[] = [BANNER];

  for (const domain of domains) out.push(`export * from "./${domain}.js";`);
  out.push("");

  out.push(
    `/** Every tool name the SuperBooks MCP endpoint exposes, in manifest order. */`,
    `export const ALL_TOOL_NAMES = [`,
  );
  for (const tools of Object.values(manifest.domains)) {
    for (const tool of tools) out.push(`  ${JSON.stringify(tool.name)},`);
  }
  out.push(`] as const;`, "");

  out.push(
    `/** Tool names gated behind the two-gate destructive check. */`,
    `export const DESTRUCTIVE_TOOL_NAMES = [`,
  );
  for (const tools of Object.values(manifest.domains)) {
    for (const tool of tools) {
      if (tool.destructive) out.push(`  ${JSON.stringify(tool.name)},`);
    }
  }
  out.push(`] as const;`, "");

  out.push(
    `export type ToolName = (typeof ALL_TOOL_NAMES)[number];`,
    `export type DestructiveToolName = (typeof DESTRUCTIVE_TOOL_NAMES)[number];`,
    "",
    `/** Domain -> namespace property name on the \`SuperBooks\` client. */`,
    `export const DOMAINS = ${JSON.stringify(domains.map(camel))} as const;`,
    "",
  );

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

const emitted = new Map<string, string>();
let total = 0;
for (const [domain, tools] of Object.entries(manifest.domains)) {
  emitted.set(`${domain}.ts`, emitDomain(domain, tools));
  total += tools.length;
}
emitted.set("index.ts", emitIndex(manifest));

if (total !== manifest.toolCount) {
  throw new Error(`manifest toolCount ${manifest.toolCount} != ${total} tools found`);
}

if (CHECK_MODE) {
  const existing = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [];
  const stale: string[] = [];

  for (const name of existing) {
    if (!emitted.has(name)) stale.push(`${name} (orphaned)`);
  }
  for (const [name, content] of emitted) {
    const path = join(OUT_DIR, name);
    if (!existsSync(path)) stale.push(`${name} (missing)`);
    else if (readFileSync(path, "utf8") !== content) stale.push(`${name} (out of date)`);
  }

  if (stale.length > 0) {
    console.error("Generated sources do not match sdk-manifest.json:");
    for (const s of stale) console.error(`  - ${s}`);
    console.error("\nRun `npm run codegen` and commit the result.");
    process.exit(1);
  }
  console.log(
    `codegen check passed — ${total} tools across ${Object.keys(manifest.domains).length} domains`,
  );
} else {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of emitted) writeFileSync(join(OUT_DIR, name), content, "utf8");
  console.log(
    `generated ${emitted.size} files — ${total} tools across ${Object.keys(manifest.domains).length} domains`,
  );
}
