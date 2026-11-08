/**
 * Generate data/schema/library.schema.json from the Zod schema, so editors
 * (VS Code YAML extension) give autocomplete and inline errors to contributors.
 * Usage: npm run schema:json  |  npm run schema:json -- --check  (CI: fail if stale)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LibrarySchema } from '../src/schema';
import { REPO_ROOT } from '../src/node';

const out = join(REPO_ROOT, 'data/schema/library.schema.json');
const schema = {
  ...z.toJSONSchema(LibrarySchema, { io: 'input' }),
  $id: 'https://pqc-deps.pages.dev/schema/library.schema.json',
  title: 'PQC Deps library entry',
};
const json = JSON.stringify(schema, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== json) {
    console.error('data/schema/library.schema.json is out of date. Run: npm run schema:json');
    process.exit(1);
  }
  console.log('JSON Schema is up to date.');
} else {
  writeFileSync(out, json);
  console.log(`Wrote ${out}`);
}
