/**
 * Rules the Zod schema can't express: cross-field consistency within one file
 * and cross-file integrity (delegation links, duplicate package names).
 */
import {
  type Algorithm,
  type Library,
  ALGORITHMS,
  REGISTRIES,
  applicableAlgorithms,
} from './schema';

export type Severity = 'error' | 'warning';
export interface LintIssue {
  libraryId: string;
  path: string;
  message: string;
  severity: Severity;
}

function algs(lib: Library) {
  return ALGORITHMS.flatMap((a) => {
    const s = lib.algorithms[a];
    return s ? [[a, s] as const] : [];
  });
}

export function lintLibrary(lib: Library, today: string = isoToday()): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (path: string, message: string, severity: Severity = 'error') =>
    issues.push({ libraryId: lib.id, path, message, severity });

  const applicable = new Set<Algorithm>(applicableAlgorithms(lib));
  const applicableSupport = algs(lib).filter(([a]) => applicable.has(a));

  // Evidence rule: anything other than `unknown` needs a source.
  for (const [a, s] of algs(lib)) {
    if (s.support !== 'unknown' && s.sources.length === 0) {
      add(
        `algorithms.${a}`,
        `support "${s.support}" has no sources; use "unknown" until there is evidence`,
      );
    }
    if (s.support === 'yes' && !s.since_version) {
      add(`algorithms.${a}.since_version`, 'supported but since_version is missing', 'warning');
    }
    if (s.support !== 'unknown' && !applicable.has(a)) {
      add(`algorithms.${a}`, `"${a}" is not in applicable_algorithms`, 'warning');
    }
  }
  if (lib.fips && lib.fips.status !== 'unknown' && lib.fips.sources.length === 0) {
    add('fips', `FIPS status "${lib.fips.status}" has no sources`);
  }

  // overall_status must agree with the per-algorithm data.
  const hasYes = applicableSupport.some(([, s]) => s.support === 'yes');
  const hasYesOrPartial = applicableSupport.some(
    ([, s]) => s.support === 'yes' || s.support === 'partial',
  );
  const hasDefaultOn = applicableSupport.some(
    ([, s]) => s.support === 'yes' && s.default_enabled === true && !s.experimental,
  );
  const st = lib.overall_status;
  if (st === 'ready' && !hasDefaultOn) {
    add(
      'overall_status',
      '"ready" needs an applicable algorithm with support "yes", default_enabled true and not experimental',
    );
  }
  if (st === 'available' && !hasYes) {
    add('overall_status', '"available" needs at least one applicable algorithm with support "yes"');
  }
  if (st === 'available' && hasDefaultOn) {
    add('overall_status', 'an algorithm is on by default; should this be "ready"?', 'warning');
  }
  if (st === 'partial' && !hasYesOrPartial) {
    add(
      'overall_status',
      '"partial" needs at least one applicable algorithm with support "yes" or "partial"',
    );
  }
  if (st === 'planned' && !lib.roadmap) {
    add('overall_status', '"planned" needs a roadmap with sources');
  }
  if (st === 'planned' && hasYes) {
    add(
      'overall_status',
      'an algorithm is already supported; should this be "partial" or "available"?',
      'warning',
    );
  }
  if (st === 'no-plan' && hasYesOrPartial) {
    add('overall_status', '"no-plan" contradicts an algorithm with support "yes" or "partial"');
  }
  if (st === 'no-plan' && lib.roadmap) {
    add('overall_status', '"no-plan" contradicts the roadmap; use "planned"');
  }
  if (st === 'n/a' && lib.delegates_to.length === 0) {
    add('delegates_to', '"n/a" needs delegates_to pointing at the library that does the crypto');
  }

  // Dates.
  if (lib.last_verified > today) add('last_verified', `date ${lib.last_verified} is in the future`);
  const allSources = [
    ...algs(lib).flatMap(([a, s]) =>
      s.sources.map((src, i) => [`algorithms.${a}.sources[${i}]`, src] as const),
    ),
    ...(lib.roadmap?.sources ?? []).map((src, i) => [`roadmap.sources[${i}]`, src] as const),
    ...(lib.fips?.sources ?? []).map((src, i) => [`fips.sources[${i}]`, src] as const),
  ];
  for (const [path, src] of allSources) {
    if (src.retrieved > today) add(`${path}.retrieved`, `date ${src.retrieved} is in the future`);
  }

  if (lib.delegates_to.some((d) => d.id === lib.id))
    add('delegates_to', 'a library cannot delegate to itself');

  return issues;
}

/** Cross-file checks over the whole catalog. */
export function lintCatalog(libs: Library[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const byId = new Map<string, Library>();
  for (const lib of libs) {
    if (byId.has(lib.id)) {
      issues.push({ libraryId: lib.id, path: 'id', message: 'duplicate id', severity: 'error' });
    }
    byId.set(lib.id, lib);
  }

  for (const lib of libs) {
    lib.delegates_to.forEach((d, i) => {
      if (!byId.has(d.id)) {
        issues.push({
          libraryId: lib.id,
          path: `delegates_to[${i}].id`,
          message: `unknown library "${d.id}"`,
          severity: 'error',
        });
      }
    });
  }

  // Cycle detection (DFS, three colours).
  const colour = new Map<string, 0 | 1 | 2>();
  const reported = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    colour.set(id, 1);
    for (const d of byId.get(id)?.delegates_to ?? []) {
      if (!byId.has(d.id)) continue;
      const c = colour.get(d.id) ?? 0;
      if (c === 1) {
        const cycle = [...stack.slice(stack.indexOf(d.id)), d.id];
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({
            libraryId: id,
            path: 'delegates_to',
            message: `delegation cycle: ${cycle.join(' -> ')}`,
            severity: 'error',
          });
        }
      } else if (c === 0) {
        visit(d.id, [...stack, d.id]);
      }
    }
    colour.set(id, 2);
  };
  for (const lib of libs) if ((colour.get(lib.id) ?? 0) === 0) visit(lib.id, [lib.id]);

  // The same package name must not map to two libraries.
  for (const reg of REGISTRIES) {
    const owner = new Map<string, string>();
    for (const lib of libs) {
      for (const name of lib.package_names[reg] ?? []) {
        const key = name.toLowerCase();
        const prev = owner.get(key);
        if (prev && prev !== lib.id) {
          issues.push({
            libraryId: lib.id,
            path: `package_names.${reg}`,
            message: `"${name}" is also listed by "${prev}"`,
            severity: 'error',
          });
        }
        owner.set(key, lib.id);
      }
    }
  }

  return issues;
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
