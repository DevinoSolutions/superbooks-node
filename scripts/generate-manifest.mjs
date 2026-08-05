#!/usr/bin/env bun
/**
 * Generates `sdk-manifest.json` — the public tool manifest that drives SDK
 * codegen.
 *
 * The manifest contains ONLY information the MCP endpoint already publishes to
 * any authenticated client via `tools/list`: tool names, descriptions, and
 * input JSON Schemas. No implementation, no internal identifiers.
 *
 * This script must run from inside the SuperBooks backend workspace, because it
 * imports the live tool registries and converts their zod schemas with that
 * workspace's own zod. Paths are supplied on the command line so this file
 * carries none.
 *
 *   bun generate-manifest.mjs <tools-dir> <output-file>
 *
 * Requires zod >= 4 (native `z.toJSONSchema`).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// Domain directories, in the order the registry composes them.
const DOMAINS = [
  "transactions",
  "invoices",
  "customers",
  "categories",
  "tags",
  "documents",
  "inbox",
  "tracker",
  "bank_accounts",
  "team",
  "search",
  "reports",
];

const [toolsDir, outFile] = process.argv.slice(2);
if (!toolsDir || !outFile) {
  console.error("usage: bun generate-manifest.mjs <tools-dir> <output-file>");
  process.exit(1);
}

/** A registry module exports one `ScopedTool[]`; find it without hardcoding names. */
function findRegistry(mod, domain) {
  for (const value of Object.values(mod)) {
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((e) => e && typeof e.id === "string" && typeof e.scope === "string" && e.tool)
    ) {
      return value;
    }
  }
  throw new Error(`no ScopedTool[] export found in domain "${domain}"`);
}

const domains = {};
let toolCount = 0;

for (const domain of DOMAINS) {
  const url = `file:///${toolsDir.replace(/\\/g, "/").replace(/\/$/, "")}/${domain}/index.ts`;
  const registry = findRegistry(await import(url), domain);

  domains[domain] = registry.map(({ id, scope, tool }) => {
    if (tool.id !== id) {
      throw new Error(`registry id "${id}" != tool id "${tool.id}" — tools/list would disagree`);
    }
    const inputSchema = z.toJSONSchema(tool.inputSchema, {
      target: "draft-2020-12",
      io: "input",
    });
    // Strip the $schema key: it is uniform across every tool and only bloats
    // the manifest that gets committed and diffed.
    delete inputSchema.$schema;

    toolCount += 1;
    return {
      name: id,
      description: tool.description,
      scope,
      // Destructive tools sit behind the two-gate check: the credential must
      // carry the scope AND the team must have destructive AI tools enabled.
      destructive: scope === "destructive",
      inputSchema,
    };
  });
}

const manifest = {
  generatedAt: new Date().toISOString(),
  toolCount,
  domains,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`wrote ${outFile}`);
console.log(`toolCount: ${toolCount}`);
for (const [d, tools] of Object.entries(domains)) {
  const destructive = tools.filter((t) => t.destructive).length;
  console.log(`  ${d}: ${tools.length} tools (${destructive} destructive)`);
}
