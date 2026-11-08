/** Node-only helpers: read the data directory from disk. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLibraryYaml, type LoadError } from './load';
import type { Library } from './schema';

export * from './load';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Directory holding the library YAML files. Defaults to data/libraries;
 * set PQC_DATA_DIR (e.g. to data/examples) to develop against sample data.
 */
export function dataDir(): string {
  const override = process.env.PQC_DATA_DIR;
  return override ? resolve(REPO_ROOT, override) : join(REPO_ROOT, 'data', 'libraries');
}

export function loadLibrariesFromDir(dir: string = dataDir()): {
  libraries: Library[];
  errors: LoadError[];
} {
  const libraries: Library[] = [];
  const errors: LoadError[] = [];
  if (!existsSync(dir))
    return { libraries, errors: [{ file: dir, message: 'directory not found' }] };
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = join(dir, name);
    const res = parseLibraryYaml(readFileSync(file, 'utf8'), file);
    if (res.ok) libraries.push(res.library);
    else errors.push(...res.errors);
  }
  return { libraries, errors };
}
