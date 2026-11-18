/**
 * GitHub code search for post-quantum identifiers in a library's repository.
 *
 * Used when no release note, changelog or watched page mentions PQC: a
 * library that never added ML-KEM has no document saying so, and "unknown"
 * would be the wrong answer. If the repository is indexed (a control search
 * for its own name finds code) and none of the terms appear, the library has
 * no PQC code. If they do appear, the evidence is somewhere the pipeline
 * didn't read, and a human should look.
 *
 * The REST code search allows ~10 requests a minute, so requests are spaced.
 * Note: "OR" in code search queries silently returns 0, so each term is a
 * separate request.
 */
import { githubJson } from './http';

export const PQC_CODE_TERMS = ['mlkem', 'kyber', 'mldsa', 'dilithium', 'X25519MLKEM768'] as const;

export interface CodeSearchResult {
  repo: string;
  /** Hits per term. */
  terms: Record<string, number>;
  /** Hits for the repository's own name: 0 means the index can't be trusted. */
  control: number;
  date: string;
}

export const totalHits = (r: CodeSearchResult) => Object.values(r.terms).reduce((a, b) => a + b, 0);
/** Indexed and nothing found: the repository has no PQC code. */
export const noPqcCode = (r: CodeSearchResult) => r.control > 0 && totalHits(r) === 0;

export async function pqcCodeSearch(
  repo: string,
  opts: {
    search?: (q: string) => Promise<number>;
    delayMs?: number;
    today?: string;
  } = {},
): Promise<CodeSearchResult> {
  const search =
    opts.search ??
    (async (q: string) =>
      (
        await githubJson<{ total_count: number }>(
          `/search/code?q=${encodeURIComponent(q)}&per_page=1`,
        )
      ).total_count);
  const delay = opts.delayMs ?? 7_000;
  const sleep = () => new Promise((r) => setTimeout(r, delay));
  const terms: Record<string, number> = {};
  for (const t of PQC_CODE_TERMS) {
    terms[t] = await search(`repo:${repo} ${t}`);
    if (terms[t]! > 0) break; // one hit is enough to know PQC code exists
    await sleep();
  }
  const name = repo
    .split('/')[1]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')[0]!;
  const control =
    totalHits({ repo, terms, control: 0, date: '' }) > 0 ? 1 : await search(`repo:${repo} ${name}`);
  return { repo, terms, control, date: opts.today ?? new Date().toISOString().slice(0, 10) };
}
