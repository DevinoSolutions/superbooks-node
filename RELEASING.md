# Releasing

Publishing is automated: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds and
publishes to npm using **trusted publishing** (OIDC) — no long-lived npm token in GitHub secrets.

There is one manual step before that can work for the first time.

## One-time setup (Amin)

npm cannot perform a package's **first** publish over OIDC: the package must already exist on the
registry before a trusted publisher can be attached to it. So `superbooks@0.1.0` has to be published
once from a laptop, after which every later release goes through CI.

### Step 1 — publish 0.1.0 manually, once

```sh
git clone https://github.com/DevinoSolutions/superbooks-node.git
cd superbooks-node
npm ci
npm run build
npm login            # the account must own, or be able to claim, the name `superbooks`
npm publish --access public
```

Note there is no `--provenance` here. Provenance requires OIDC, which is not available from a laptop;
adding the flag would fail. Releases published by CI get provenance automatically.

### Step 2 — configure the trusted publisher

On [npmjs.com](https://www.npmjs.com/package/superbooks) → the package page → **Settings** →
**Trusted Publisher** → _GitHub Actions_, enter exactly:

| Field                | Value             |
| -------------------- | ----------------- |
| Organization or user | `DevinoSolutions` |
| Repository           | `superbooks-node` |
| Workflow filename    | `release.yml`     |
| Environment name     | _(leave empty)_   |

The workflow filename is the **filename only**, not a path — not `.github/workflows/release.yml`.
The environment field is optional and this workflow does not use a GitHub environment, so leaving it
blank is correct; filling it in would cause OIDC to be rejected.

If npm offers an "allowed actions" choice, `npm publish` is sufficient.

### Step 3 — confirm

Cut a `v0.1.1` release per below and check that the npm page shows the green **Provenance** badge
linking back to the workflow run.

## What actually gets published

Eleven files: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and seven under `dist/` —
`index.js`, `index.cjs`, `cli.js`, `index.d.ts`, `index.d.cts`, and the two sourcemaps. Roughly
118 kB packed. No source _files_, no tests, and not `sdk-manifest.json` — though source _text_ does
ship, inside the sourcemaps, as the next paragraph explains.

The two `.map` files matter more than their size suggests: they carry `sourcesContent`, meaning the
**full text of every source file** — around 83 kB, including `src/generated/`, which is where tool
descriptions end up as doc comments. Source paths inside them are relative (`../src/errors.ts`), so
no local filesystem paths leak.

Keeping the maps is a deliberate trade — they make stack traces from published builds readable. The
consequence is that **`dist/` must be rebuilt after any change to tool descriptions**, or the
sourcemaps will still contain the old text even though the compiled output no longer does. `npm run
build` runs from `prepublishOnly` and the release workflow builds explicitly, so a normal release
cannot publish a stale `dist/`. It is only a hazard if someone hand-publishes after editing the
manifest without rebuilding.

If you would rather not ship source text at all, set `sourcemap: false` in `tsup.config.ts`; nothing
else depends on the maps.

## Cutting a release

1. Update `version` in `package.json` **and** `VERSION` in `src/version.ts`. They must match — the
   release workflow refuses to publish if they disagree with the tag.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version heading.
3. Commit, then tag and push:

```sh
git commit -am "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

The workflow verifies the tag against both version fields, runs lint, typecheck, the codegen drift
check, and tests, then publishes.

## Requirements the workflow already handles

Trusted publishing needs npm CLI **11.5.1+** and Node **22.14.0+**; the workflow pins Node 22 and
upgrades npm before publishing. It also requests `id-token: write`, without which npm cannot verify
the OIDC claim.
