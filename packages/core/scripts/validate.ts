/**
 * Validate every library YAML file: schema + lint rules.
 * Usage: npm run validate [-- <dir> ...]   (default: data/libraries and data/examples)
 * Exits 1 on any error. Warnings are printed but don't fail.
 */
import { resolve, relative } from 'node:path';
import { lintCatalog, lintLibrary, type LintIssue } from '../src/index';
import { loadLibrariesFromDir, REPO_ROOT } from '../src/node';

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2).map((d) => resolve(d))
  : [resolve(REPO_ROOT, 'data/libraries'), resolve(REPO_ROOT, 'data/examples')];

let errors = 0;
let warnings = 0;
for (const dir of dirs) {
  const { libraries, errors: loadErrors } = loadLibrariesFromDir(dir);
  const issues: LintIssue[] = [
    ...libraries.flatMap((l) => lintLibrary(l)),
    ...lintCatalog(libraries),
  ];
  console.log(`\n${relative(REPO_ROOT, dir) || dir}: ${libraries.length} valid file(s)`);
  for (const e of loadErrors) {
    errors++;
    console.log(`  ERROR ${relative(REPO_ROOT, e.file)}: ${e.message}`);
  }
  for (const i of issues) {
    if (i.severity === 'error') errors++;
    else warnings++;
    console.log(`  ${i.severity.toUpperCase()} ${i.libraryId} ${i.path}: ${i.message}`);
  }
}
console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
