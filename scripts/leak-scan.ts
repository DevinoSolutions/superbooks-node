#!/usr/bin/env tsx
/**
 * Fails the build if anything publicly visible reveals implementation detail.
 *
 *   npm run leak-scan
 *
 * Scope is the WHOLE REPOSITORY, not just the npm tarball. This repo is public,
 * so `src/`, `scripts/`, `test/`, the workflows and RELEASING.md are all
 * readable — scanning only the packaged files would leave most of the surface
 * unchecked.
 *
 * Tool descriptions are generated into the manifest, the generated sources and
 * — least obviously — the published sourcemaps, which embed full source text
 * via `sourcesContent`. That last one is why regenerating is not sufficient on
 * its own: a stale `dist/` keeps serving old strings after the sources are
 * clean.
 *
 * Every pattern here is a GENERIC class — a storage vendor, a Postgres concept,
 * a credential shape — and every sample is INVENTED. Naming a database concept
 * reveals nothing; a scanner whose fixtures are real strings would republish
 * the very text it exists to keep out. Specific internal identifiers are
 * checked upstream, where the manifest is generated.
 *
 * Patterns are deliberately narrow. A scanner that cries wolf is one people
 * learn to ignore, which is how a leak survives review in the first place, so
 * every pattern that could match ordinary prose carries an explicit guard.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface LeakPattern {
  name: string;
  re: RegExp;
  /** An INVENTED string this pattern MUST flag. Asserted by the test suite. */
  sample: string;
  /** Strings this pattern must NOT flag, for the guarded ones. */
  notSamples?: string[];
}

export const PATTERNS: LeakPattern[] = [
  {
    name: "database engine named",
    re: /\bpostgres(ql)?\b/i,
    sample: "rows are read straight out of Postgres",
  },
  {
    // Case-SENSITIVE and bounded. Unbounded /gin/i matches bridging, engine,
    // imagine, logging, plugin, originating. Bounded-but-insensitive still
    // matches a lowercase "gin" standing alone in prose. The disclosing form is
    // always the index type in caps.
    name: "index type named",
    re: /\bGIN\b/,
    sample: "a GIN index backs the lookup",
    notSamples: ["bridging", "engine", "imagine", "logging", "plugin", "originating"],
  },
  {
    name: "full-text-search internals",
    re: /\bts(vector|query)\b|\bto_tsquery\b|\bts_rank\w*/i,
    sample: "ranked by ts_rank_cd over a stored tsvector",
  },
  {
    // `\w` before the colon and a negative lookahead for a second asterisk.
    // A bare `:\*` matches markdown bold labels — `**Docs:**` contains a colon
    // followed by an asterisk. Prefix terms are always of the form `term:*`.
    name: "search prefix syntax",
    re: /\w:\*(?!\*)/,
    sample: "expanded to alpha:* & beta:*",
    notSamples: ["**Docs:**", "**Requires:**", "**Dependencies:**", "**Note:** see below"],
  },
  {
    name: "SQL operator named",
    re: /\bILIKE\b/i,
    sample: "an ILIKE wildcard on the label column",
  },
  {
    // Three forms, because a vocabulary matcher catches the term of art and
    // never the prose form: the algorithm, the extension, and the threshold
    // written out in words.
    //
    // Every alternative requires the literal word "similarity" adjacent to a
    // number, or a term of art. That is deliberate: a relevance or score
    // parameter a caller must set has to document its range and default, and a
    // pattern loose enough to flag that would be a permanent false positive on
    // legitimate published text. The tempting fix for a noisy pattern is to
    // delete it, so the guard is pinned below.
    name: "fuzzy-match implementation named",
    re: /\btrigram\b|\bpg_trgm\b|\d+(\.\d+)?\s*%?[\s-]*similarity|\bsimilarity\s*\(|\bsimilarity\s+(threshold|score)\s*(of\s+)?[\d.]+/i,
    sample: "falls back to a 45%-similarity fuzzy match",
    notSamples: [
      "substring and fuzzy matching to catch near-miss spellings",
      "Minimum relevance score (0-1) for a result to be included. Defaults to 0.05.",
      "results are ordered by relevance",
    ],
  },
  {
    // Inflections included: prose says "SETS NULL" as readily as the canonical
    // "ON DELETE SET NULL", and a canonical-only pattern misses it.
    name: "FK cascade semantics",
    re: /\bCASCADE[- ]DELETES?\b|\bON DELETE\b|\bSETS? NULL\b/i,
    sample: "child rows CASCADE-DELETE and the parent link SETS NULL",
  },
  {
    name: "storage vendor named",
    re: /\bS3\b|\bGCS\b|\bAzure Blob\b|\bB2\b|\bbackblaze\b|\bCloudflare R2\b/i,
    sample: "the object is removed from the S3 bucket",
  },
  {
    name: "copyleft licence contamination",
    re: /\bAGPL\b|\bAffero\b|\bGPL-?[23]\b|\bGNU General Public\b/i,
    sample: "portions licensed under the AGPL-3.0",
  },
  {
    // Absolute paths from an author's machine: a username, a sync folder, or a
    // home directory is enough to identify a person and their local layout.
    // `/home/runner/` is excluded — it is the shared CI workspace, names nobody,
    // and appears in ordinary workflow output.
    name: "local filesystem path",
    re: /[A-Za-z]:\\Users\\|\bOneDrive\b|\/Users\/[a-z][\w.-]*\/|\/home\/(?!runner\/)[a-z][\w.-]*\/[A-Za-z]/i,
    sample: "written to C:\\Users\\example\\projects\\scratch",
    notSamples: ["/home/runner/work", "relative/users/path", "C:/Users-not-a-path"],
  },
  {
    // Shapes only. A key that looks real is treated as real, because the cost
    // of guessing wrong is a live credential in a public repo.
    name: "credential shape",
    re: /\bsb_[0-9a-f]{32,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    sample: "AKIAIOSFODNN7EXAMPLE",
    notSamples: ["sb_your_api_key_here", "sb_not_a_real_key", "Bearer <token>"],
  },
  {
    name: "internal roadmap admission",
    re: /\bPhase \d+ (TODO|WIP)\b/i,
    sample: "cleanup is deferred (Phase 9 TODO)",
  },
  {
    name: "cursor described as an offset",
    re: /stringified (row )?offset/i,
    sample: "the cursor is a stringified offset",
  },
];

/**
 * Files that necessarily quote every pattern verbatim and must not flag
 * themselves.
 *
 * Matched by path SUFFIX on normalised separators, never by exact
 * repo-relative path: an exact match silently stops applying the moment the
 * same file is read from inside an archive, where the member is prefixed
 * (`superbooks-0.1.0/scripts/leak-scan.ts`).
 *
 * Each entry keeps its directory segment so the suffix cannot swallow an
 * unrelated file that merely ends in a similar name.
 */
export const SELF_REFERENTIAL = ["scripts/leak-scan.ts", "test/leak-scan.test.ts"];

export function isSelfReferential(path: string): boolean {
  const normalised = path.replace(/\\/g, "/");
  return SELF_REFERENTIAL.some((s) => normalised === s || normalised.endsWith(`/${s}`));
}

export interface Finding {
  file: string;
  name: string;
  match: string;
  context: string;
}

/**
 * Reports every DISTINCT match per pattern, not just the first.
 *
 * Reporting only the first hit per class is fine for a pass/fail gate but bad
 * for the job this exists to serve: a human scrubbing text before publication.
 * One field can hold two leaks of the same class, and first-match-only surfaces
 * one, so the reviewer fixes it, re-runs, and only then learns about the
 * second. That converges, but at one round trip per leak.
 *
 * Repeats of the same literal are collapsed — three copies of one string is one
 * thing to fix, and the duplication is usually an artifact of the surface
 * (generated output, embedded sourcemaps) rather than three separate leaks.
 */
export function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  // Scanning raw file bytes is what makes nesting depth irrelevant — a leak in
  // a parameter description six levels down is just text in the file. The one
  // place that breaks is JSON escaping: a description containing a newline
  // serialises as a two-character \n, so a multi-word pattern like "ON DELETE"
  // no longer matches across it. Descriptions are authored upstream, so a
  // multi-line one would silently open a hole; the escaped form is scanned too.
  const unescaped = text.replace(/\\[nrt]/g, " ");
  const surfaces = unescaped === text ? [text] : [text, unescaped];

  for (const { name, re } of PATTERNS) {
    for (const surface of surfaces) {
      const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
      for (const match of surface.matchAll(global)) {
        const key = `${name} ${match[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const index = match.index ?? 0;
        findings.push({
          file,
          name,
          match: match[0],
          context: surface
            .slice(Math.max(0, index - 60), index + 80)
            .replace(/\s+/g, " ")
            .trim(),
        });
      }
    }
  }
  return findings;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".vscode", ".idea"]);
const SCANNABLE = /\.(json|ts|cts|mts|tsx|js|cjs|mjs|jsx|map|md|ya?ml|txt)$/;

function* walk(path: string): Generator<string> {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    if (SCANNABLE.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    yield* walk(join(path, entry));
  }
}

/** Warns when dist/ predates its inputs — the stale-artifact trap. */
function warnIfDistStale(): void {
  const dist = join(ROOT, "dist");
  if (!existsSync(dist)) {
    console.log("note: dist/ absent — run `npm run build` so built output is scanned too");
    return;
  }
  const distTime = Math.min(
    ...[...walk(dist)].map((f) => statSync(f).mtimeMs).concat(Number.POSITIVE_INFINITY),
  );
  const inputs = [join(ROOT, "sdk-manifest.json"), join(ROOT, "src")];
  const newest = Math.max(
    ...inputs.flatMap((i) => [...walk(i)].map((f) => statSync(f).mtimeMs)).concat(0),
  );
  if (newest > distTime) {
    console.warn(
      "WARNING: dist/ is older than src/ or sdk-manifest.json. A stale build can still\n" +
        "         carry old strings in its sourcemaps. Run `npm run build` before trusting\n" +
        "         a pass here.",
    );
  }
}

function main(): void {
  warnIfDistStale();

  const findings: Finding[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (isSelfReferential(rel)) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    findings.push(...scanText(readFileSync(file, "utf8"), rel));
  }

  if (findings.length > 0) {
    console.error(
      `\nLEAK SCAN FAILED — ${findings.length} finding(s) across ${scanned} file(s):\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}`);
      console.error(`    [${f.name}] matched ${JSON.stringify(f.match)}`);
      console.error(`    ...${f.context}...\n`);
    }
    console.error("These strings are publicly visible. If a tool description changed upstream,");
    console.error("run `npm run codegen && npm run build` — a stale dist/ keeps old text in its");
    console.error("sourcemaps even after the sources are clean.\n");
    process.exit(1);
  }

  console.log(
    `leak scan passed — ${scanned} files (${skipped} self-referential skipped), ${PATTERNS.length} patterns, 0 findings`,
  );
}

// Only run when invoked as a script, so the test suite can import the parts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
