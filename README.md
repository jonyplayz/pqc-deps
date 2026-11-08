# PQC Deps

Is your dependency tree ready for post-quantum cryptography? PQC Deps tracks
whether popular open-source crypto libraries support the NIST PQC standards
(ML-KEM / FIPS 203, ML-DSA / FIPS 204, SLH-DSA / FIPS 205) and hybrid TLS key
exchange, since which version, and what's planned. Every claim links to a source.

> Status: early MVP, under construction. See milestones below.

## Repository layout

| Path | What |
| --- | --- |
| `packages/core` | Zod schema, lint rules, YAML loader (later: manifest parsers, matching). Shared by site, pipeline and future CLI. |
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
```

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
