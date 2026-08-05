import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (name: string): string =>
  readFileSync(join(ROOT, "src", "generated", `${name}.ts`), "utf8");

describe("generated sources are current", () => {
  // The real guard: if sdk-manifest.json changes and nobody reruns codegen,
  // this fails. It is the same command CI runs.
  it("match sdk-manifest.json", () => {
    // Invoked through `node --import tsx` rather than the `npx` shim: on
    // Windows, Node refuses to spawn a .cmd file without a shell.
    expect(() =>
      execFileSync(process.execPath, ["--import", "tsx", "scripts/codegen.ts", "--check"], {
        cwd: ROOT,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});

// Snapshots over three domains chosen for coverage rather than size: `tags`
// spans all three scopes, `bank_accounts` is a lone read tool, and `team` is
// the no-argument case.
describe("snapshots", () => {
  it("tags", () => {
    expect(read("tags")).toMatchSnapshot();
  });

  it("bank_accounts", () => {
    expect(read("bank_accounts")).toMatchSnapshot();
  });

  it("team", () => {
    expect(read("team")).toMatchSnapshot();
  });
});

describe("emitter behaviour", () => {
  const transactions = read("transactions");
  const customers = read("customers");

  it("turns a zod enum into a string literal union", () => {
    expect(transactions).toContain(
      `status?: "posted" | "pending" | "excluded" | "completed" | "archived" | "exported";`,
    );
  });

  it("marks required fields as required and everything else optional", () => {
    expect(transactions).toMatch(
      /export type TransactionsGetParams = \{\s*\/\*\*[^}]*?\*\/\s*id: string;/,
    );
    expect(transactions).toContain("cursor?: string;");
  });

  it("renders a nullable field as a union with null", () => {
    expect(customers).toContain("billingEmail?: string | null;");
    // A merely-optional field must NOT pick up `| null`.
    expect(customers).toContain("name?: string;");
  });

  it("carries schema descriptions into JSDoc", () => {
    expect(transactions).toContain("/** Inclusive lower bound, YYYY-MM-DD */");
  });

  it("records defaults as @defaultValue", () => {
    expect(transactions).toContain("@defaultValue 25");
  });

  it("emits type aliases, which stay assignable to Record<string, unknown>", () => {
    expect(transactions).toContain("export type TransactionsListParams = {");
    expect(transactions).not.toContain("export interface Transactions");
  });

  it("never emits the `any` type", () => {
    // Matches `any` only in type position — the word also appears in tool
    // descriptions ("any of the following"), which is harmless prose.
    const anyType = /(:\s*any\b|\bany\[\]|<any>|\bas any\b)/;
    for (const domain of ["transactions", "invoices", "customers", "reports", "tracker"]) {
      expect(read(domain), `${domain} emits the any type`).not.toMatch(anyType);
    }
  });

  it("flags destructive tools in their doc comment", () => {
    expect(read("tags")).toContain("@remarks DESTRUCTIVE");
    // A read-only domain has nothing to flag.
    expect(read("reports")).not.toContain("@remarks DESTRUCTIVE");
  });
});
