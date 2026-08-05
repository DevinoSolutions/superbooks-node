import { describe, expect, it } from "vitest";
import { PATTERNS, SELF_REFERENTIAL, isSelfReferential, scanText } from "../scripts/leak-scan.js";

/**
 * A leak scanner that has never been seen to fail is evidence of nothing. Every
 * pattern must be shown to catch something, and every guarded pattern must be
 * shown to reject the false positive it was written to avoid.
 *
 * Every fixture below is INVENTED. Fixtures are as public as the code they
 * guard, so a suite built from real strings would republish the text the gate
 * exists to keep out.
 */

describe("every pattern detects a leak", () => {
  it.each(PATTERNS.map((p) => [p.name, p] as const))("%s", (_name, pattern) => {
    expect(pattern.re.test(pattern.sample), `pattern failed to match its own sample`).toBe(true);
  });

  it("has a sample for every pattern", () => {
    for (const p of PATTERNS) expect(p.sample.length, `${p.name} has no sample`).toBeGreaterThan(0);
  });
});

describe("guarded patterns reject their known false positives", () => {
  const guarded = PATTERNS.filter((p) => p.notSamples?.length);

  it("covers the patterns that can match ordinary prose", () => {
    expect(guarded.map((p) => p.name).sort()).toEqual([
      "credential shape",
      "fuzzy-match implementation named",
      "index type named",
      "local filesystem path",
      "search prefix syntax",
    ]);
  });

  it.each(guarded.flatMap((p) => (p.notSamples ?? []).map((s) => [p.name, p, s] as const)))(
    "%s does not match %s",
    (_name, pattern, sample) => {
      expect(pattern.re.test(sample)).toBe(false);
    },
  );
});

describe("implementation disclosures are caught end to end", () => {
  // Invented sentences in the shape a description takes when it says too much.
  const disclosing = [
    "the object is deleted from the S3 bucket as well",
    "ranked with ts_rank_cd rather than by date",
    "matched as prefixes against a GIN-indexed tsvector in Postgres",
    "the query alpha beta is expanded to alpha:* & beta:*",
    "related rows CASCADE-DELETE when the parent goes",
    "attachment cleanup is deferred (Phase 9 TODO)",
    "the join column SETS NULL once the owner is removed",
    "an ILIKE substring match on the label",
    "the cursor is a stringified offset into the result set",
    "a 45%-similarity fuzzy match catches near misses",
  ];

  it.each(disclosing)("flags %s", (text) => {
    expect(scanText(text, "fixture.md").length).toBeGreaterThan(0);
  });
});

describe("prose variants of the same disclosure are caught", () => {
  // The other ways a writer phrases a disclosure the canonical term already
  // covers. A vocabulary matcher catches the term of art and misses the
  // paraphrase, so each one is pinned against both.
  const variants = [
    "matched with a similarity threshold of 0.3",
    "rows above 0.5 similarity are returned",
    "uses pg_trgm for fuzzy matching",
    "ORDER BY similarity(name, $1) DESC",
  ];

  it.each(variants)("flags %s", (text) => {
    expect(scanText(text, "fixture.md").length).toBeGreaterThan(0);
  });
});

describe("secrets and machine-local paths are caught", () => {
  const sensitive = [
    "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "-----BEGIN RSA PRIVATE KEY-----",
    "built from C:\\Users\\example\\code\\project",
    "synced through OneDrive before the build",
    "cached under /Users/example/Library/Caches",
    "vendored helper carries an AGPL-3.0 header",
  ];

  it.each(sensitive)("flags %s", (text) => {
    expect(scanText(text, "fixture.md").length).toBeGreaterThan(0);
  });
});

describe("ordinary published text is NOT flagged", () => {
  // Text of the kind that legitimately ships. A scanner that flags these makes
  // the gate unusable, and the usual response to a noisy gate is to delete the
  // pattern rather than fix it.
  const clean = [
    "Triggers customer email delivery in the background.",
    "the underlying stored file is permanently deleted",
    "results are ordered by relevance",
    "Free-text query. Words are matched as prefix terms combined with AND.",
    "all tag assignments for this document are removed",
    "The uploaded file itself is retained.",
    "unlinks the customer from invoices and recurring schedules",
    "Case-insensitive substring match on the document name only.",
    "Pagination cursor from the previous page's `cursor`. Omit on the first page.",
    "substring and fuzzy matching on the name to catch near-miss spellings",
    "Deleting an entry has no knock-on effects",
    // A caller-visible parameter has to document its range and default.
    "Minimum relevance score (0-1) for a result to be included. Defaults to 0.05.",
    "Returns an array of `{ id, type, relevance, created_at, data }` rows",
    // The documented placeholder must never read as a real credential.
    'new SuperBooks({ apiKey: "sb_your_api_key_here" })',
  ];

  it.each(clean)("allows %s", (text) => {
    expect(scanText(text, "fixture.md")).toEqual([]);
  });
});

describe("self-exclusion", () => {
  it("matches the plain repo-relative paths", () => {
    for (const s of SELF_REFERENTIAL) expect(isSelfReferential(s)).toBe(true);
  });

  it("still matches when the file is read from inside an archive", () => {
    // Exact-path matching silently stops applying once a tarball prefixes
    // every member.
    expect(isSelfReferential("superbooks-0.1.0/scripts/leak-scan.ts")).toBe(true);
    expect(isSelfReferential("package/test/leak-scan.test.ts")).toBe(true);
  });

  it("still matches with Windows separators", () => {
    expect(isSelfReferential("scripts\\leak-scan.ts")).toBe(true);
    expect(isSelfReferential("superbooks-0.1.0\\test\\leak-scan.test.ts")).toBe(true);
  });

  it("does NOT swallow unrelated files with similar names", () => {
    // The opposite failure: a suffix broad enough to silently skip real files.
    for (const path of [
      "src/generated/leak-scan.ts",
      "src/my-leak-scan.ts",
      "scripts/leak-scan-helper.ts",
      "src/leak-scan.test.ts",
      "docs/scripts-leak-scan.ts",
    ]) {
      expect(isSelfReferential(path), `${path} should NOT be excluded`).toBe(false);
    }
  });
});

describe("scanText output", () => {
  it("names the file, the pattern, and gives surrounding context", () => {
    const [finding] = scanText("some prose about an S3 bucket here", "dist/index.js.map");
    expect(finding).toMatchObject({ file: "dist/index.js.map", name: "storage vendor named" });
    expect(finding?.match).toBe("S3");
    expect(finding?.context).toContain("S3");
  });

  it("reports every distinct pattern that matches", () => {
    const names = scanText("GIN-indexed tsvector via Postgres to_tsquery", "x.md").map(
      (f) => f.name,
    );
    expect(new Set(names).size).toBeGreaterThanOrEqual(3);
  });

  it("reports every distinct match WITHIN one pattern, not just the first", () => {
    // Two disclosures of the same class in one field. First-match-only reports
    // one and hides the second until the reviewer fixes it and re-runs.
    const text = "a trigram index, plus a 45%-similarity fuzzy match on the name";
    const matches = scanText(text, "x.md")
      .filter((f) => f.name === "fuzzy-match implementation named")
      .map((f) => f.match);
    expect(matches).toEqual(["trigram", "45%-similarity"]);
  });

  it("detects a leak planted in a DEEPLY NESTED parameter description", () => {
    // Parameter descriptions nest several levels deep and greatly outnumber the
    // tool descriptions above them. Scanning raw file bytes makes depth
    // irrelevant, but that is a property worth pinning rather than assuming.
    const manifest = {
      domains: {
        widgets: [
          {
            name: "widgets_search",
            description: "Search widgets.",
            inputSchema: {
              type: "object",
              properties: {
                filters: {
                  type: "object",
                  properties: {
                    labels: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          mode: {
                            type: "string",
                            description:
                              "matched via Postgres to_tsquery against a GIN-indexed tsvector",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const names = scanText(JSON.stringify(manifest, null, 2), "sdk-manifest.json").map(
      (f) => f.name,
    );
    expect(new Set(names)).toEqual(
      new Set(["database engine named", "index type named", "full-text-search internals"]),
    );
  });

  it("still detects a multi-word leak broken by a JSON-escaped newline", () => {
    // A description containing a newline serialises as a two-character \n, so
    // "ON DELETE" stops matching across it. Descriptions are authored upstream,
    // so this would fail open silently.
    const serialised = JSON.stringify({
      properties: { a: { description: "rows are removed ON\nDELETE of the parent" } },
    });
    const names = scanText(serialised, "sdk-manifest.json").map((f) => f.name);
    expect(names).toContain("FK cascade semantics");
  });

  it("collapses repeats of the same literal into one finding", () => {
    // Generated output and embedded sourcemaps duplicate the same string many
    // times over; that is one thing to fix, not N.
    const matches = scanText("S3 bucket ... S3 bucket ... S3 bucket", "x.md").filter(
      (f) => f.name === "storage vendor named",
    );
    expect(matches).toHaveLength(1);
  });
});
