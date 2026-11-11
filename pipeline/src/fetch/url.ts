/** Evidence from arbitrary pages listed in pipeline.watch_urls (docs, release pages, mailing lists). */
import type { Library } from '@pqc-deps/core';
import { htmlTitle, htmlToText } from './html';
import { fetchText } from './http';
import type { FetchedDoc, FetchResult, SourceKind } from './types';

export function guessKind(url: string): SourceKind {
  const u = url.toLowerCase();
  if (/release[-_]?notes|\/releases?\/|changelog|\/news/.test(u)) return 'release-notes';
  if (/mail|lists\.|pipermail|groups\.google|marc\.info/.test(u)) return 'mailing-list';
  if (/\/blog|\/posts?\//.test(u)) return 'blog';
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === 'csrc.nist.gov' &&
      parsed.pathname.startsWith('/projects/cryptographic-module-validation')
    )
      return 'certificate';
  } catch {
    /* not a URL: fall through */
  }
  if (/\/issues?\//.test(u)) return 'issue';
  if (/\/pull\//.test(u)) return 'pull-request';
  return 'docs';
}

export async function fetchUrls(lib: Library): Promise<FetchResult> {
  const docs: FetchedDoc[] = [];
  const warnings: string[] = [];
  for (const url of lib.pipeline?.watch_urls ?? []) {
    try {
      const { text, contentType } = await fetchText(url);
      if (/pdf|octet-stream|image\//.test(contentType)) {
        warnings.push(`Skipped ${url}: unsupported content type ${contentType}`);
        continue;
      }
      const isHtml = /html/.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
      docs.push({
        url,
        title: (isHtml ? htmlTitle(text) : undefined) ?? url,
        kind: guessKind(url),
        text: isHtml ? htmlToText(text) : text,
      });
    } catch (e) {
      warnings.push(`Could not fetch ${url}: ${(e as Error).message}`);
    }
  }
  return { docs, warnings };
}
