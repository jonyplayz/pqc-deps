/**
 * Check the identity metadata of catalog entries against the real world:
 * the GitHub repo exists (and isn't archived/renamed), homepage and watched
 * URLs respond, and every package name exists in its registry.
 *
 *   npm run identity -- [<id> ...]      (default: all entries)
 * Exits 1 if anything is missing.
 */
import { join } from 'node:path';
import type { Library, Registry } from '@pqc-deps/core';
import { loadLibrariesFromDir, REPO_ROOT } from '@pqc-deps/core/node';
import { githubRepo } from './fetch/github';
import { fetchText, githubJson, HttpError } from './fetch/http';

type Check = { what: string; ok: boolean; detail?: string };

/** Go module proxy escaping: uppercase letters become "!" + lowercase. */
const goEscape = (m: string) => m.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

async function exists(url: string): Promise<{ ok: boolean; detail?: string; body?: string }> {
  try {
    const { text } = await fetchText(url, { timeoutMs: 20_000 });
    return { ok: true, body: text };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message,
    };
  }
}

export async function checkPackage(registry: Registry, name: string): Promise<Check> {
  const what = `${registry} package ${name}`;
  switch (registry) {
    case 'npm': {
      const r = await exists(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
      return { what, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }
    case 'pypi': {
      const r = await exists(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      return { what, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }
    case 'cargo': {
      const r = await exists(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
      return { what, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }
    case 'go': {
      // A package path inside a module isn't itself on the proxy; walk up to find its module.
      const parts = name.split('/');
      for (let n = parts.length; n >= 3; n--) {
        const mod = parts.slice(0, n).join('/');
        const r = await exists(`https://proxy.golang.org/${goEscape(mod)}/@latest`);
        if (r.ok)
          return {
            what,
            ok: true,
            ...(n < parts.length ? { detail: `package inside module ${mod}` } : {}),
          };
      }
      return { what, ok: false, detail: 'not found on proxy.golang.org' };
    }
    case 'maven': {
      const [g, a] = name.split(':');
      const r = await exists(
        `https://repo1.maven.org/maven2/${g!.replace(/\./g, '/')}/${a}/maven-metadata.xml`,
      );
      return { what, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }
    case 'nuget': {
      const r = await exists(
        `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`,
      );
      return { what, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }
  }
}

export async function checkIdentity(lib: Library): Promise<Check[]> {
  const checks: Check[] = [];
  const repo = githubRepo(lib);
  if (repo) {
    try {
      const r = await githubJson<{ full_name: string; archived: boolean }>(`/repos/${repo}`);
      const renamed = r.full_name.toLowerCase() !== repo.toLowerCase();
      checks.push({
        what: `GitHub repo ${repo}`,
        ok: !r.archived,
        ...(r.archived
          ? { detail: 'archived' }
          : renamed
            ? { detail: `moved to ${r.full_name}` }
            : {}),
      });
    } catch (e) {
      checks.push({
        what: `GitHub repo ${repo}`,
        ok: false,
        detail: e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message,
      });
    }
  } else if (lib.repo) {
    const r = await exists(lib.repo);
    checks.push({ what: `repo ${lib.repo}`, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) });
  }
  for (const url of [lib.homepage, ...(lib.pipeline?.watch_urls ?? [])].filter(
    Boolean,
  ) as string[]) {
    const r = await exists(url);
    checks.push({
      what: url === lib.homepage ? `homepage ${url}` : `watch URL ${url}`,
      ok: r.ok,
      ...(r.detail ? { detail: r.detail } : {}),
    });
  }
  for (const [reg, names] of Object.entries(lib.package_names) as Array<[Registry, string[]]>) {
    for (const n of names) checks.push(await checkPackage(reg, n));
  }
  return checks;
}

async function main() {
  const ids = process.argv.slice(2);
  const { libraries } = loadLibrariesFromDir(join(REPO_ROOT, 'data', 'libraries'));
  const targets = ids.length ? libraries.filter((l) => ids.includes(l.id)) : libraries;
  let failures = 0;
  for (const lib of targets) {
    const checks = await checkIdentity(lib);
    const bad = checks.filter((c) => !c.ok);
    const notes = checks.filter((c) => c.ok && c.detail);
    failures += bad.length;
    console.log(`${bad.length ? '✗' : '✓'} ${lib.id} (${checks.length} checks)`);
    for (const c of [...bad, ...notes])
      console.log(`    ${c.ok ? 'note' : 'FAIL'}: ${c.what}${c.detail ? ` (${c.detail})` : ''}`);
  }
  console.log(
    `\n${failures} failing check(s) across ${targets.length} entr${targets.length === 1 ? 'y' : 'ies'}.`,
  );
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/identity.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
