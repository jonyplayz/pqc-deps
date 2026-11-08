import { ManifestError, type Dependency, type ParsedManifest } from '../types';

const SECTIONS: Array<[string, string | undefined]> = [
  ['dependencies', undefined],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
];

const EXACT = /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

function parseJson(text: string, what: string): Record<string, any> {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (e) {
    throw new ManifestError(`Not valid JSON (${what}): ${(e as Error).message}`);
  }
  throw new ManifestError(`Expected a JSON object (${what})`);
}

export function parsePackageJson(text: string): ParsedManifest {
  const json = parseJson(text, 'package.json');
  const warnings: string[] = [];
  const seen = new Map<string, Dependency>();
  for (const [section, scope] of SECTIONS) {
    const deps = json[section];
    if (!deps || typeof deps !== 'object') continue;
    for (let [name, spec] of Object.entries<string>(deps)) {
      if (typeof spec !== 'string') continue;
      // Aliases: "my-jose": "npm:jose@^5.0.0"
      const alias = /^npm:(@?[^@]+)@?(.*)$/.exec(spec);
      if (alias) {
        name = alias[1]!;
        spec = alias[2] || '*';
      }
      let version: string | undefined = spec.trim();
      if (
        /^(file:|link:|workspace:|git|github:|https?:)|\//.test(version) &&
        !/^\d/.test(version)
      ) {
        version = undefined; // local path / git / URL: no registry version
      }
      if (!seen.has(name) || scope === undefined) {
        seen.set(name, {
          registry: 'npm',
          name,
          ...(version ? { version } : {}),
          exact: !!version && EXACT.test(version),
          direct: true,
          ...(scope ? { scope } : {}),
        });
      }
    }
  }
  const node = json.engines?.node;
  return {
    format: 'package.json',
    registry: 'npm',
    dependencies: [...seen.values()],
    ...(typeof node === 'string'
      ? { runtime: { registry: 'npm', name: 'node', version: node } }
      : {}),
    warnings: seen.size
      ? warnings
      : [
          ...warnings,
          'No dependencies found. Lockfiles (package-lock.json) also list transitive dependencies.',
        ],
  };
}

export function parsePackageLock(text: string): ParsedManifest {
  const json = parseJson(text, 'package-lock.json');
  const warnings: string[] = [];
  const out = new Map<string, Dependency>();
  const add = (d: Dependency) => {
    const key = `${d.name}@${d.version}`;
    const prev = out.get(key);
    if (!prev || (d.direct && !prev.direct)) out.set(key, d);
  };

  if (json.packages && typeof json.packages === 'object') {
    // lockfileVersion 2 / 3
    const root = json.packages[''] ?? {};
    const rootDeps = new Map<string, string | undefined>();
    for (const [section, scope] of SECTIONS) {
      for (const n of Object.keys(root[section] ?? {}))
        if (!rootDeps.has(n)) rootDeps.set(n, scope);
    }
    for (const [path, entry] of Object.entries<any>(json.packages)) {
      if (!path || !entry || entry.link) continue;
      const idx = path.lastIndexOf('node_modules/');
      if (idx === -1) continue; // workspace package source dir
      const installedAs = path.slice(idx + 'node_modules/'.length);
      const name: string = entry.name ?? installedAs;
      if (!entry.version) continue;
      const direct = path === `node_modules/${installedAs}` && rootDeps.has(installedAs);
      const scope = direct
        ? rootDeps.get(installedAs)
        : entry.dev
          ? 'dev'
          : entry.optional
            ? 'optional'
            : undefined;
      add({
        registry: 'npm',
        name,
        version: entry.version,
        exact: true,
        direct,
        ...(scope ? { scope } : {}),
      });
    }
  } else if (json.dependencies && typeof json.dependencies === 'object') {
    // lockfileVersion 1: nested tree, no record of which are direct.
    warnings.push(
      'Lockfile v1 does not record which dependencies are direct; all are listed as transitive.',
    );
    const walk = (deps: Record<string, any>) => {
      for (const [name, entry] of Object.entries<any>(deps)) {
        if (entry?.version && !/^(file:|git|https?:)/.test(entry.version)) {
          add({
            registry: 'npm',
            name,
            version: entry.version,
            exact: true,
            direct: false,
            ...(entry.dev ? { scope: 'dev' } : {}),
          });
        }
        if (entry?.dependencies) walk(entry.dependencies);
      }
    };
    walk(json.dependencies);
  } else {
    throw new ManifestError(
      'This does not look like a package-lock.json (no "packages" or "dependencies").',
    );
  }
  return {
    format: 'package-lock.json',
    registry: 'npm',
    dependencies: [...out.values()],
    warnings,
  };
}
