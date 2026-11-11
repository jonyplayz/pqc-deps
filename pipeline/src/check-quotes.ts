/**
 * Re-fetch every source in the catalog and check that its quote is still on
 * the page (same whitespace/markdown-tolerant matching the pipeline uses).
 *
 *   npm run check-quotes -- [<id> ...]      (default: all entries)
 * Exits 1 if any quote can't be found.
 */
import { join } from 'node:path';
import type { Library, Source } from '@pqc-deps/core';
import { loadLibrariesFromDir, REPO_ROOT } from '@pqc-deps/core/node';
import { fetchText, githubJson } from './fetch/http';
import { htmlToText } from './fetch/html';
import { checkQuote } from './verify';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  /* no .env file */
}

const cache = new Map<string, Promise<string>>();

/** Fetch the text a source URL shows a reader, using APIs where the HTML is a JS shell. */
async function sourceText(url: string): Promise<string> {
  const u = new URL(url);
  let m: RegExpExecArray | null;
  if (u.hostname === 'github.com') {
    if ((m = /^\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/.exec(u.pathname)))
      return (await fetchText(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`)).text;
    if ((m = /^\/([^/]+\/[^/]+)\/releases\/tag\/(.+)$/.exec(u.pathname))) {
      const r = await githubJson<{ name: string | null; body: string | null }>(
        `/repos/${m[1]}/releases/tags/${m[2]}`,
      );
      return `${r.name ?? ''}\n${r.body ?? ''}`;
    }
    if ((m = /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)$/.exec(u.pathname))) {
      const issue = await githubJson<{ title: string; body: string | null }>(
        `/repos/${m[1]}/issues/${m[2]}`,
      );
      const comments = await githubJson<Array<{ body: string }>>(
        `/repos/${m[1]}/issues/${m[2]}/comments?per_page=100`,
      );
      return [issue.title, issue.body ?? '', ...comments.map((c) => c.body)].join('\n');
    }
  }
  if (
    u.hostname === 'bitbucket.org' &&
    (m = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)/.exec(u.pathname))
  ) {
    const { text } = await fetchText(
      `https://api.bitbucket.org/2.0/repositories/${m[1]}/pullrequests/${m[2]}`,
    );
    const pr = JSON.parse(text) as { title: string; description?: string };
    return `${pr.title}\n${pr.description ?? ''}`;
  }
  const { text, contentType } = await fetchText(url);
  return /html/i.test(contentType ?? '') || /^\s*</.test(text) ? htmlToText(text) : text;
}

function sources(lib: Library): Array<[string, Source]> {
  return [
    ...Object.entries(lib.algorithms).flatMap(([a, s]) =>
      (s?.sources ?? []).map((src) => [`algorithms.${a}`, src] as [string, Source]),
    ),
    ...(lib.roadmap?.sources ?? []).map((src) => ['roadmap', src] as [string, Source]),
    ...(lib.fips?.sources ?? []).map((src) => ['fips', src] as [string, Source]),
  ];
}

async function main() {
  const ids = process.argv.slice(2);
  const { libraries } = loadLibrariesFromDir(join(REPO_ROOT, 'data', 'libraries'));
  const targets = ids.length ? libraries.filter((l) => ids.includes(l.id)) : libraries;
  let failures = 0;
  for (const lib of targets) {
    for (const [field, src] of sources(lib)) {
      if (!cache.has(src.url)) cache.set(src.url, sourceText(src.url));
      let result: string;
      try {
        const text = await cache.get(src.url)!;
        const r = checkQuote(src.quote, { id: 'S', url: src.url, title: src.title, text } as never);
        result = r.ok ? 'ok' : `NOT FOUND (${r.reason})`;
      } catch (e) {
        result = `FETCH FAILED (${(e as Error).message})`;
      }
      if (result !== 'ok') failures++;
      console.log(`${result === 'ok' ? '✓' : '✗'} ${lib.id} ${field}: ${result} — ${src.url}`);
    }
  }
  console.log(`\n${failures} problem(s).`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
