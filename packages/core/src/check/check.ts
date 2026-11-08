/**
 * Match parsed manifest dependencies against the catalog and produce a report.
 * Pure and browser-safe: the catalog comes in as plain data (e.g. /api/catalog.json).
 */
import { applicableAlgorithms, type Algorithm, type Registry, type Status } from '../constants';
import { delegationTree, type DelegationNode } from '../delegation';
import type { Library } from '../schema';
import { looksCryptoRelated, normalizeName } from './normalize';
import type { Dependency, ParsedManifest } from './types';
import { compareVersions, lowerBound } from './version';

export type Verdict =
  /** Your version already includes PQC support. */
  | 'ok'
  /** Your version predates PQC support: upgrade to `upgradeTo`. */
  | 'upgrade'
  /** A range whose lowest allowed version predates support; the installed one may be fine. */
  | 'check-installed'
  /** The library supports PQC, but we don't know which version you use. */
  | 'version-unknown'
  /** Package versions don't follow the library's version numbers. */
  | 'not-comparable'
  /** No stable PQC support yet (planned / no-plan). */
  | 'not-yet'
  /** Status unknown. */
  | 'unknown'
  /** Crypto is done by another library; see the chain. */
  | 'delegated';

export interface Finding {
  library: Library;
  /** Undefined for runtime findings without a matching dependency. */
  dependency?: Dependency;
  /** How it matched: a package name, a Go sub-package inside a module, or the runtime. */
  matchedBy: 'package' | 'module' | 'runtime';
  note?: string;
  verdict: Verdict;
  /** Minimum version with PQC support, when we can tell. */
  upgradeTo?: string;
  /** Algorithms available at `upgradeTo` (or already, for 'ok'). */
  algorithms: Algorithm[];
  chain: DelegationNode[];
}

export interface CheckReport {
  format: ParsedManifest['format'];
  registry: Registry;
  totalDependencies: number;
  findings: Finding[];
  /** Untracked dependencies whose names suggest crypto/TLS (heuristic). */
  possiblyCrypto: Dependency[];
  /** Everything else that isn't in the catalog. */
  untracked: Dependency[];
  statusCounts: Partial<Record<Status, number>>;
  warnings: string[];
}

export interface CatalogIndex {
  byId: Map<string, Library>;
  /** registry → normalized package name → library */
  byPackage: Map<Registry, Map<string, Library>>;
  libraries: Library[];
}

export function indexCatalog(libraries: Library[]): CatalogIndex {
  const byPackage = new Map<Registry, Map<string, Library>>();
  for (const lib of libraries) {
    for (const [reg, names] of Object.entries(lib.package_names) as Array<[Registry, string[]]>) {
      const m = byPackage.get(reg) ?? new Map<string, Library>();
      for (const n of names) m.set(normalizeName(reg, n), lib);
      byPackage.set(reg, m);
    }
  }
  return { byId: new Map(libraries.map((l) => [l.id, l])), byPackage, libraries };
}

/** The earliest stable since_version across applicable algorithms with support. */
function pqcBaseline(lib: Library): { version?: string; algorithms: Algorithm[] } {
  const applicable = applicableAlgorithms(lib);
  const supported = applicable.flatMap((a) => {
    const s = lib.algorithms[a];
    return s && (s.support === 'yes' || s.support === 'partial')
      ? [[a, s.since_version] as const]
      : [];
  });
  const versions = supported.map(([, v]) => v).filter((v): v is string => !!v);
  const min = versions.sort((a, b) => compareVersions(a, b) ?? 0)[0];
  return {
    ...(min ? { version: min } : {}),
    algorithms: supported
      .filter(([, v]) => !min || !v || (compareVersions(v, min) ?? 1) <= 0)
      .map(([a]) => a),
  };
}

function judge(lib: Library, registry: Registry, version: string | undefined, exact: boolean) {
  const base = pqcBaseline(lib);
  const out = (verdict: Verdict, extra: Partial<Finding> = {}) => ({
    verdict,
    algorithms: base.algorithms,
    ...extra,
  });

  switch (lib.overall_status) {
    case 'n/a':
      return out('delegated');
    case 'planned':
    case 'no-plan':
      return out('not-yet');
    case 'unknown':
      return out('unknown');
  }
  if (!base.version) return out('version-unknown');
  if (lib.separate_versioning?.includes(registry))
    return out('not-comparable', { upgradeTo: base.version });
  if (!version) return out('version-unknown', { upgradeTo: base.version });

  const v = exact ? version : lowerBound(version);
  if (!v) return out('version-unknown', { upgradeTo: base.version });
  const cmp = compareVersions(v, base.version);
  if (cmp === undefined) return out('version-unknown', { upgradeTo: base.version });
  if (cmp >= 0) return out('ok');
  return out(exact ? 'upgrade' : 'check-installed', { upgradeTo: base.version });
}

function matchDependency(
  dep: Dependency,
  index: CatalogIndex,
): Array<{ lib: Library; matchedBy: 'package' | 'module'; note?: string }> {
  const pkgs = index.byPackage.get(dep.registry);
  if (!pkgs) return [];
  const key = normalizeName(dep.registry, dep.name);
  const exact = pkgs.get(key);
  if (dep.registry !== 'go') return exact ? [{ lib: exact, matchedBy: 'package' }] : [];
  // go.mod lists modules; the catalog may also track packages inside one
  // (golang.org/x/crypto/ssh inside golang.org/x/crypto). Report both.
  const out: Array<{ lib: Library; matchedBy: 'package' | 'module'; note?: string }> = exact
    ? [{ lib: exact, matchedBy: 'package' }]
    : [];
  for (const [name, lib] of pkgs) {
    if (name.startsWith(`${key}/`) && lib !== exact) {
      out.push({
        lib,
        matchedBy: 'module',
        note: `Applies if you import ${name} (part of module ${dep.name}).`,
      });
    }
  }
  return out;
}

export function checkManifest(manifest: ParsedManifest, index: CatalogIndex): CheckReport {
  const findings: Finding[] = [];
  const possiblyCrypto: Dependency[] = [];
  const untracked: Dependency[] = [];
  const seen = new Set<string>();

  for (const dep of manifest.dependencies) {
    const matches = matchDependency(dep, index);
    if (!matches.length) {
      (looksCryptoRelated(dep.name) ? possiblyCrypto : untracked).push(dep);
      continue;
    }
    for (const { lib, matchedBy, note } of matches) {
      const key = `${lib.id}|${dep.name}|${dep.version ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        library: lib,
        dependency: dep,
        matchedBy,
        ...(note ? { note } : {}),
        ...judge(lib, dep.registry, dep.version, dep.exact),
        chain: delegationTree(lib, index.byId),
      });
    }
  }

  // Runtimes / standard libraries implied by the ecosystem (Node.js crypto for npm, Go's crypto for go.mod…).
  for (const lib of index.libraries) {
    if (!lib.implicit_for?.includes(manifest.registry)) continue;
    if (findings.some((f) => f.library.id === lib.id)) continue;
    const rt = manifest.runtime;
    findings.push({
      library: lib,
      matchedBy: 'runtime',
      note: rt?.version
        ? `Your manifest targets ${rt.name} ${rt.version}.`
        : `Used by every ${manifest.registry} project; your manifest doesn't state a ${rt?.name ?? 'runtime'} version.`,
      ...judge(lib, manifest.registry, rt?.version, false),
      chain: delegationTree(lib, index.byId),
    });
  }

  const statusCounts: Partial<Record<Status, number>> = {};
  for (const id of new Set(findings.map((f) => f.library.id))) {
    const s = index.byId.get(id)!.overall_status;
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const order: Record<Verdict, number> = {
    upgrade: 0,
    'check-installed': 1,
    'not-yet': 2,
    unknown: 3,
    'version-unknown': 4,
    'not-comparable': 5,
    delegated: 6,
    ok: 7,
  };
  findings.sort(
    (a, b) => order[a.verdict] - order[b.verdict] || a.library.name.localeCompare(b.library.name),
  );

  return {
    format: manifest.format,
    registry: manifest.registry,
    totalDependencies: manifest.dependencies.length,
    findings,
    possiblyCrypto,
    untracked,
    statusCounts,
    warnings: manifest.warnings,
  };
}
