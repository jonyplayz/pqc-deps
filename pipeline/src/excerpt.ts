/**
 * Cut fetched documents down to the passages that mention PQC, so prompts stay
 * small (cheap, and within free-tier context limits). Quotes are still verified
 * against the full document text.
 */
import type { EvidenceDoc, FetchedDoc } from './fetch/types';

export const PQC_PATTERN =
  /ML-?KEM|MLKEM|Kyber|ML-?DSA|MLDSA|Dilithium|SLH-?DSA|SPHINCS|FN-?DSA|Falcon|\bHQC\b|post[- ]?quantum|\bPQC\b|\bPQ\b|quantum[- ](?:safe|resistant|secure)|X25519MLKEM768|SecP256r1MLKEM768|SecP384r1MLKEM1024|X25519Kyber768|hybrid key exchange|FIPS[ -]?20[3-6]/i;

export interface ExcerptOptions {
  /** Lines of context around each hit. */
  context?: number;
  maxCharsPerDoc?: number;
  maxCharsTotal?: number;
}

export interface Excerpted extends EvidenceDoc {
  excerpt: string;
  hits: number;
}

const KIND_PRIORITY: Record<string, number> = {
  'release-notes': 0,
  changelog: 1,
  docs: 2,
  'maintainer-post': 3,
  'mailing-list': 4,
  blog: 5,
  'pull-request': 6,
  certificate: 7,
  issue: 8,
  commit: 9,
  other: 10,
};

export function excerptDoc(
  text: string,
  context = 4,
  maxChars = 12_000,
): { excerpt: string; hits: number } {
  const lines = text.split(/\r?\n/);
  const keep = new Set<number>();
  let hits = 0;
  lines.forEach((l, i) => {
    if (!PQC_PATTERN.test(l)) return;
    hits++;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
      keep.add(j);
  });
  if (!hits) return { excerpt: '', hits: 0 };
  // Always keep the first lines: they carry the release name / version / title.
  for (let j = 0; j < Math.min(3, lines.length); j++) keep.add(j);

  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1) out.push('[…]');
    out.push(lines[i]!);
    prev = i;
  }
  if (prev < lines.length - 1) out.push('[…]');
  let excerpt = out.join('\n').replace(/^\[…\]\n/, '');
  if (excerpt.length > maxChars) excerpt = `${excerpt.slice(0, maxChars)}\n[… truncated]`;
  return { excerpt, hits };
}

/**
 * Keep documents that mention PQC, assign ids D1..Dn, and fit them into the
 * character budget (release notes and changelogs first).
 */
export function selectEvidence(
  docs: FetchedDoc[],
  opts: ExcerptOptions = {},
): { selected: Excerpted[]; dropped: number } {
  const { context = 4, maxCharsPerDoc = 12_000, maxCharsTotal = 80_000 } = opts;
  const candidates = docs
    .map((d) => ({ d, ...excerptDoc(d.text, context, maxCharsPerDoc) }))
    .filter((c) => c.hits > 0)
    .sort(
      (a, b) =>
        (KIND_PRIORITY[a.d.kind] ?? 10) - (KIND_PRIORITY[b.d.kind] ?? 10) ||
        (b.d.date ?? '').localeCompare(a.d.date ?? '') ||
        b.hits - a.hits,
    );
  const selected: Excerpted[] = [];
  let total = 0;
  for (const c of candidates) {
    if (total + c.excerpt.length > maxCharsTotal) continue;
    total += c.excerpt.length;
    selected.push({ ...c.d, id: `D${selected.length + 1}`, excerpt: c.excerpt, hits: c.hits });
  }
  return { selected, dropped: candidates.length - selected.length };
}
