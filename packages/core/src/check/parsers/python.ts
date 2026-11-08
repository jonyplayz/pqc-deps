import { parse as parseToml } from 'smol-toml';
import { ManifestError, type Dependency, type ParsedManifest } from '../types';

/**
 * Parse one PEP 508 requirement ("cryptography[ssh]>=42,<45 ; python_version>'3.8'").
 * Returns undefined for things that aren't named requirements.
 */
export function parsePep508(req: string, scope?: string): Dependency | undefined {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(req);
  if (!m) return undefined;
  const name = m[1]!;
  let rest = m[2]!.split(';')[0]!.trim(); // drop environment markers
  if (rest.startsWith('@')) {
    return { registry: 'pypi', name, exact: false, direct: true, ...(scope ? { scope } : {}) }; // direct URL
  }
  rest = rest.replace(/^\((.*)\)$/, '$1').trim();
  const version = rest || undefined;
  const exact = !!version && /^===?\s*[\w.!+-]+$/.test(version) && !version.includes('*');
  return {
    registry: 'pypi',
    name,
    ...(version ? { version: version.replace(/\s+/g, '') } : {}),
    exact,
    direct: true,
    ...(scope ? { scope } : {}),
  };
}

export function parseRequirementsTxt(text: string): ParsedManifest {
  const warnings: string[] = [];
  const deps: Dependency[] = [];
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      if (/^(-r|--requirement|-c|--constraint)\b/.test(line)) {
        warnings.push(`Skipped "${line}": paste the referenced file separately.`);
      }
      continue; // -e, --index-url, --hash, etc.
    }
    if (/^(\.|\/|[a-z+]+:\/\/)/i.test(line)) continue; // local path or URL without a name
    const d = parsePep508(line.replace(/\s--hash=\S+/g, ''));
    if (d) deps.push(d);
    else warnings.push(`Could not parse line: ${line}`);
  }
  return { format: 'requirements.txt', registry: 'pypi', dependencies: deps, warnings };
}

function poetryDep(name: string, spec: unknown, scope?: string): Dependency | undefined {
  let version: string | undefined;
  if (typeof spec === 'string') version = spec;
  else if (spec && typeof spec === 'object' && 'version' in spec)
    version = String((spec as any).version);
  else if (Array.isArray(spec)) version = undefined;
  // Poetry: a bare "1.2.3" means ==1.2.3.
  const exact = !!version && /^\d[\w.]*$/.test(version);
  return {
    registry: 'pypi',
    name,
    ...(version && version !== '*' ? { version } : {}),
    exact,
    direct: true,
    ...(scope ? { scope } : {}),
  };
}

export function parsePyprojectToml(text: string): ParsedManifest {
  let toml: Record<string, any>;
  try {
    toml = parseToml(text) as Record<string, any>;
  } catch (e) {
    throw new ManifestError(`Not valid TOML: ${(e as Error).message}`);
  }
  const deps: Dependency[] = [];
  const pushAll = (reqs: unknown, scope?: string) => {
    if (!Array.isArray(reqs)) return;
    for (const r of reqs)
      if (typeof r === 'string') {
        const d = parsePep508(r, scope);
        if (d) deps.push(d);
      }
  };

  const project = toml.project ?? {};
  pushAll(project.dependencies);
  for (const [group, reqs] of Object.entries(project['optional-dependencies'] ?? {}))
    pushAll(reqs, `optional:${group}`);
  for (const [group, reqs] of Object.entries(toml['dependency-groups'] ?? {}))
    pushAll(reqs, `group:${group}`);

  const poetry = toml.tool?.poetry ?? {};
  let pythonReq: string | undefined = project['requires-python'];
  const poetryTable = (table: Record<string, unknown> | undefined, scope?: string) => {
    for (const [name, spec] of Object.entries(table ?? {})) {
      if (name.toLowerCase() === 'python') {
        if (typeof spec === 'string') pythonReq ??= spec;
        continue;
      }
      const d = poetryDep(name, spec, scope);
      if (d) deps.push(d);
    }
  };
  poetryTable(poetry.dependencies);
  poetryTable(poetry['dev-dependencies'], 'dev');
  for (const [group, g] of Object.entries<any>(poetry.group ?? {}))
    poetryTable(g?.dependencies, `group:${group}`);

  return {
    format: 'pyproject.toml',
    registry: 'pypi',
    dependencies: deps,
    ...(pythonReq ? { runtime: { registry: 'pypi', name: 'python', version: pythonReq } } : {}),
    warnings: deps.length ? [] : ['No dependencies found in [project] or [tool.poetry].'],
  };
}
