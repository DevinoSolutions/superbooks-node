# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-04

Initial release.

### Added

- `SuperBooks` client with typed, per-domain namespaces covering all 45 MCP tools across 12 domains:
  transactions, invoices, customers, categories, tags, documents, inbox, tracker, bank accounts,
  team, search, and reports.
- Argument types generated from `sdk-manifest.json`, the published tool surface, via
  `scripts/codegen.ts`. CI fails when the generated sources drift from the manifest.
- Minimal MCP Streamable HTTP transport with no runtime dependencies, handling both JSON and
  server-sent-event responses, session ids, and the initialize handshake.
- Typed error model: `SuperBooksError` plus `SuperBooksAuthError` (401),
  `SuperBooksPermissionError` (403), `SuperBooksRateLimitError` (429, exposing `retryAfterSeconds`),
  `SuperBooksConnectionError`, `SuperBooksProtocolError`, and `SuperBooksToolError`.
- Automatic retry of rate-limited requests, twice by default, honouring `Retry-After`. 5xx responses
  are not retried, because tool calls are not guaranteed idempotent.
- `sb.tools.list()` and `sb.tools.call()` escape hatches for tools this version does not yet know.
- ESM and CommonJS builds with type declarations for both.

[unreleased]: https://github.com/DevinoSolutions/superbooks-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DevinoSolutions/superbooks-node/releases/tag/v0.1.0
