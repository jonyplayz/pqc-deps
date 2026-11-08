import type { Library } from '@pqc-deps/core';
import { fetchGithub } from './github';
import { fetchUrls } from './url';
import type { FetchResult } from './types';

export * from './types';
export { githubRepo } from './github';

/** All evidence sources for one library. */
export async function fetchEvidence(lib: Library): Promise<FetchResult> {
  const [gh, urls] = await Promise.all([fetchGithub(lib), fetchUrls(lib)]);
  const warnings = [...gh.warnings, ...urls.warnings];
  if (
    !gh.docs.length &&
    !urls.docs.length &&
    !lib.pipeline?.watch_urls?.length &&
    !lib.repo?.includes('github.com')
  ) {
    warnings.push('No evidence sources configured: add a GitHub repo or pipeline.watch_urls.');
  }
  return { docs: [...gh.docs, ...urls.docs], warnings };
}
