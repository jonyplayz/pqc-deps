/** Every YAML file in the repo must pass schema + lint with zero errors. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { lintCatalog, lintLibrary } from '../src/index';
import { loadLibrariesFromDir, REPO_ROOT } from '../src/node';

for (const dir of ['data/libraries', 'data/examples']) {
  describe(dir, () => {
    const { libraries, errors } = loadLibrariesFromDir(join(REPO_ROOT, dir));

    it('all files parse against the schema', () => {
      expect(errors).toEqual([]);
    });

    it('all files pass lint rules', () => {
      const issues = [
        ...libraries.flatMap((l) => lintLibrary(l)),
        ...lintCatalog(libraries),
      ].filter((i) => i.severity === 'error');
      expect(issues).toEqual([]);
    });
  });
}

it('example data covers delegation and implicit runtimes', () => {
  const { libraries } = loadLibrariesFromDir(join(REPO_ROOT, 'data/examples'));
  expect(libraries.map((l) => l.id)).toEqual(['example-jwt', 'example-runtime', 'example-tls']);
});
