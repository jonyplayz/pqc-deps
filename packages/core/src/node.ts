/** Node-only helpers: read the data directory from disk. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseLibraryYaml, type LoadError } from './load';
import type { Library } from './schema';

export * from './load';

/**
 * The repo root: the nearest ancestor of the working directory whose
 * package.json declares workspaces. Derived from cwd (not import.meta.url)
 * because bundlers such as Astro/Vite move this module during builds.
 */
function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(process.cwd());

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
