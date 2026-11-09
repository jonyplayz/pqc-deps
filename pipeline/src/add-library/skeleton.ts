/** Turn a validated input into a new catalog entry and check it against the catalog. */
import { LibrarySchema, lintCatalog, lintLibrary, type Library } from '@pqc-deps/core';
import { normalizeName } from '@pqc-deps/core/check';
import { slugify, type NewLibraryInput } from './input';

export function buildSkeleton(
  input: NewLibraryInput,
  existing: Library[],
  today: string,
): { library?: Library; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = input.id ?? slugify(input.name);
  if (!id || id.length < 2)
    errors.push('Could not derive an id from the name; pass an explicit id.');

  const clash = existing.find((l) => l.id === id);
  if (clash) errors.push(`"${id}" is already in the catalog (${clash.name}). Refresh it instead.`);
  const sameRepo = existing.find(
    (l) => l.repo && l.repo.replace(/\/$/, '') === input.repo.replace(/\/$/, ''),
  );
  // Several entries may share a repo (e.g. RustCrypto/signatures holds ml-dsa and slh-dsa).
  if (sameRepo)
    warnings.push(
      `${input.repo} is also the repo of "${sameRepo.id}"; make sure this is a separate library.`,
    );

  for (const [reg, names] of Object.entries(input.package_names)) {
    for (const n of names ?? []) {
      const owner = existing.find((l) =>
        (l.package_names[reg as keyof Library['package_names']] ?? []).some(
          (x) => normalizeName(reg as never, x) === normalizeName(reg as never, n),
        ),
      );
      if (owner) errors.push(`${reg} package "${n}" already belongs to "${owner.id}".`);
    }
  }
  for (const d of input.delegates_to) {
    if (!existing.some((l) => l.id === d)) errors.push(`delegates_to: no catalog entry "${d}".`);
  }
  if (errors.length) return { errors, warnings };

  const parsed = LibrarySchema.safeParse({
    id,
    name: input.name,
    ecosystem: input.ecosystem,
    ...(input.description ? { description: input.description } : {}),
    ...(input.homepage ? { homepage: input.homepage } : {}),
    repo: input.repo,
    package_names: input.package_names,
    delegates_to: input.delegates_to.map((d) => ({ id: d })),
    ...(input.applicable_algorithms ? { applicable_algorithms: input.applicable_algorithms } : {}),
    overall_status: 'unknown',
    last_verified: today,
    ...(input.watch_urls.length ? { pipeline: { watch_urls: input.watch_urls } } : {}),
  });
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      warnings,
    };
  }
  const library = parsed.data;
  const issues = [...lintLibrary(library, today), ...lintCatalog([...existing, library])].filter(
    (i) => i.severity === 'error' && (i.libraryId === id || i.message.includes(`"${id}"`)),
  );
  if (issues.length) return { errors: issues.map((i) => `${i.path}: ${i.message}`), warnings };
  return { library, errors: [], warnings };
}
