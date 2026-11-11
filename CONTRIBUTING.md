# Contributing to PQC Deps

Thanks for helping! The most valuable contributions are **accurate, sourced
data** about libraries' post-quantum cryptography support.

## Fix or update a library

1. Find the file in `data/libraries/<id>.yaml` (the id is the last part of the
   library's page URL).
2. **Every claim needs a source**: a link to release notes, a changelog, docs or a
   maintainer post, with a short `quote` copied word for word from that page and
   the date you read it (`retrieved`). If you can't cite it, leave it `unknown`.
3. Run `npm install` and `npm run validate`.
4. Open a pull request. A maintainer checks every source before merging.

Not comfortable with YAML? Use **Suggest a correction** on the library page, or
open an issue with the source link.

## Add a library

Use the [request form](https://pqc-deps.pages.dev/request) or the
_Request a library_ issue template. Maintainers can also run
`npm run add-library` (see the README).

## Reviewer locks

If you correct something the evidence pipeline keeps getting wrong, add a lock
to the entry so it isn't re-proposed:

```yaml
pipeline:
  locked:
    - path: algorithms.ml-kem.since_version
      reason: 0.23.37 added ML-KEM-1024, not ML-KEM as such
```

## Code changes

```bash
npm install
npm test            # all tests
npm run typecheck
npm run format      # Prettier
npm run dev         # site at http://localhost:4321
```

Keep pull requests small and focused, include tests for behaviour changes, and
describe what you checked. CI must pass before merging.

## Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).
