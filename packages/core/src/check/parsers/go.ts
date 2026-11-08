import { ManifestError, type Dependency, type ParsedManifest } from '../types';

export function parseGoMod(text: string): ParsedManifest {
  if (!/^\s*module\s+\S+/m.test(text))
    throw new ManifestError('This does not look like a go.mod (no module line).');
  const warnings: string[] = [];
  const deps = new Map<string, Dependency>();
  const replaces: Array<{ from: string; fromVersion?: string; to: string; toVersion?: string }> =
    [];
  let goVersion: string | undefined;
  let toolchain: string | undefined;
  let block: 'require' | 'replace' | 'other' | undefined;

  const handleRequire = (body: string, comment: string) => {
    const m = /^(\S+)\s+(\S+)/.exec(body);
    if (!m) return;
    deps.set(m[1]!, {
      registry: 'go',
      name: m[1]!,
      version: m[2]!,
      exact: true,
      direct: !/\bindirect\b/.test(comment),
    });
  };
  const handleReplace = (body: string) => {
    const m = /^(\S+)(?:\s+(\S+))?\s*=>\s*(\S+)(?:\s+(\S+))?/.exec(body);
    if (m)
      replaces.push({
        from: m[1]!,
        ...(m[2] ? { fromVersion: m[2] } : {}),
        to: m[3]!,
        ...(m[4] ? { toVersion: m[4] } : {}),
      });
  };

  for (const raw of text.split(/\r?\n/)) {
    const ci = raw.indexOf('//');
    const comment = ci >= 0 ? raw.slice(ci) : '';
    const line = (ci >= 0 ? raw.slice(0, ci) : raw).trim();
    if (block) {
      if (line === ')') {
        block = undefined;
      } else if (line && block === 'require') handleRequire(line, comment);
      else if (line && block === 'replace') handleReplace(line);
      continue;
    }
    if (!line) continue;
    const [kw, ...restParts] = line.split(/\s+/);
    const rest = restParts.join(' ');
    if (rest === '(') {
      block = kw === 'require' ? 'require' : kw === 'replace' ? 'replace' : 'other';
      continue;
    }
    if (kw === 'go') goVersion = rest;
    else if (kw === 'toolchain') toolchain = rest.replace(/^go/, '');
    else if (kw === 'require') handleRequire(rest, comment);
    else if (kw === 'replace') handleReplace(rest);
  }

  for (const r of replaces) {
    const d = deps.get(r.from);
    if (!d || (r.fromVersion && r.fromVersion !== d.version)) continue;
    if (r.toVersion) {
      deps.delete(r.from);
      deps.set(r.to, { ...d, name: r.to, version: r.toVersion });
    } else {
      warnings.push(
        `${r.from} is replaced by a local path (${r.to}); its version can't be checked.`,
      );
      deps.set(r.from, { registry: 'go', name: d.name, exact: false, direct: d.direct });
    }
  }

  // The newer of `go` and `toolchain` is the minimum Go release that builds this module.
  const runtimeVersion = [goVersion, toolchain]
    .filter(Boolean)
    .sort((a, b) => a!.localeCompare(b!, undefined, { numeric: true }))
    .pop();
  return {
    format: 'go.mod',
    registry: 'go',
    dependencies: [...deps.values()],
    ...(runtimeVersion ? { runtime: { registry: 'go', name: 'go', version: runtimeVersion } } : {}),
    warnings,
  };
}
