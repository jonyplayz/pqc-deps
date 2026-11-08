# PQC Deps

Is your dependency tree ready for post-quantum cryptography? PQC Deps tracks
whether popular open-source crypto libraries support the NIST PQC standards
(ML-KEM / FIPS 203, ML-DSA / FIPS 204, SLH-DSA / FIPS 205) and hybrid TLS key
exchange, since which version, and what's planned. Every claim links to a source.

> Status: early MVP, under construction. See milestones below.

## Repository layout

| Path | What |
| --- | --- |
| `site/` | Astro static site: home, catalog, library pages, methodology, about, JSON API. |
| `packages/core` | Zod schema, lint rules, YAML loader, manifest parsers and matching (`src/check/`). Shared by site, pipeline and future CLI. |
| `data/libraries/*.yaml` | The catalog. One file per library. |
| `data/examples/*.yaml` | Fictional entries for tests and local development. |
| `data/schema/library.schema.json` | JSON Schema generated from the Zod schema (editor autocomplete). |
| `proposals/` | Evidence-pipeline output awaiting human review. |

## Local development

Requires Node 22+.

```bash
npm install
npm test             # unit + data tests
npm run validate     # schema + lint all YAML files
npm run typecheck
npm run schema:json  # regenerate the JSON Schema after editing schema.ts

npm run dev:examples   # site at http://localhost:4321 using fictional example data
npm run dev            # site using the real catalog in data/libraries
npm run build          # static build into site/dist (fails if any data file is invalid)
```

Builds made from `data/examples` show a banner and are marked `noindex`.

The site also publishes a static JSON API: `/api/catalog.json` and
`/api/libraries/<id>.json`.

## Manifest checker

`/check` parses dependency files **in the browser** and matches them against
`/api/catalog.json`. Supported: `package.json`, `package-lock.json`,
`requirements.txt`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle(.kts)`,
`libs.versions.toml`, `Cargo.toml`, `Cargo.lock`.

The logic lives in `packages/core/src/check/` (browser-safe, no Zod) so the
future CLI and GitHub Action can reuse it. Useful library fields:

- `package_names`: how packages map to a library, per registry
- `implicit_for`: registries where this runtime/stdlib applies automatically
  (e.g. Node.js crypto for every npm project)
- `separate_versioning`: registries whose package versions don't follow the
  library's versions (e.g. a `-sys` binding crate), so no version comparison

## Adding or editing a library

1. Create `data/libraries/<id>.yaml` (the file name must equal `id`). Start the
   file with `# yaml-language-server: $schema=../schema/library.schema.json`
   for autocomplete in VS Code.
2. **Every claim needs a source** with a URL, a verbatim `quote` and a
   `retrieved` date. If you can't cite it, leave the field `unknown`.
3. Run `npm run validate`, then open a pull request.

See `data/examples/example-tls.yaml` for an entry that uses every field.

## Licenses

Code: MIT (`LICENSE`). Data in `data/`: CC BY 4.0 (`data/LICENSE.md`).
