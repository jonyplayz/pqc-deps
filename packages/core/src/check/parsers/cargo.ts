import { parse as parseToml } from 'smol-toml';
import { ManifestError, type Dependency, type ParsedManifest } from '../types';

function toml(text: string): Record<string, any> {
  try {
    return parseToml(text) as Record<string, any>;
  } catch (e) {
    throw new ManifestError(`Not valid TOML: ${(e as Error).message}`);
  }
}

export function parseCargoToml(text: string): ParsedManifest {
  const doc = toml(text);
  const warnings: string[] = [];
  const deps = new Map<string, Dependency>();

  const table = (t: Record<string, any> | undefined, scope?: string) => {
    for (const [key, spec] of Object.entries(t ?? {})) {
      let name = key;
      let version: string | undefined;
      if (typeof spec === 'string') version = spec;
      else if (spec && typeof spec === 'object') {
        if (spec.package) name = String(spec.package); // renamed dependency
        if (spec.version) version = String(spec.version);
        if (spec.workspace === true)
          warnings.push(`${name}: version is set in the workspace Cargo.toml.`);
      }
      if (!deps.has(name) || (!scope && deps.get(name)!.scope)) {
        // Cargo "1.2.3" is a caret requirement, never an exact pin (that's "=1.2.3").
        deps.set(name, {
          registry: 'cargo',
          name,
          ...(version ? { version } : {}),
          exact: !!version && /^=\s*\d/.test(version),
          direct: true,
          ...(scope ? { scope } : {}),
        });
      }
    }
  };
  table(doc.dependencies);
  table(doc['dev-dependencies'], 'dev');
  table(doc['build-dependencies'], 'build');
  for (const target of Object.values<any>(doc.target ?? {})) {
    table(target?.dependencies);
    table(target?.['dev-dependencies'], 'dev');
    table(target?.['build-dependencies'], 'build');
  }
  table(doc.workspace?.dependencies);
  if (!deps.size)
    warnings.push('No dependencies found. Cargo.lock also lists transitive dependencies.');
  return { format: 'Cargo.toml', registry: 'cargo', dependencies: [...deps.values()], warnings };
}

export function parseCargoLock(text: string): ParsedManifest {
  const doc = toml(text);
  if (!Array.isArray(doc.package))
    throw new ManifestError('This does not look like a Cargo.lock (no [[package]] entries).');
  const deps: Dependency[] = [];
  for (const p of doc.package) {
    // Skip workspace members (no registry source).
    if (!p?.name || !p?.version || !p.source) continue;
    deps.push({
      registry: 'cargo',
      name: String(p.name),
      version: String(p.version),
      exact: true,
      direct: false,
    });
  }
  return {
    format: 'Cargo.lock',
    registry: 'cargo',
    dependencies: deps,
    warnings: [
      'Cargo.lock does not record which dependencies are direct; all are listed as transitive.',
    ],
  };
}
