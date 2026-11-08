/**
 * The hard rule: a claim survives only if its quote is really in the cited
 * document. Anything that fails drops back to "unknown" / null.
 */
import {
  ALGORITHMS,
  applicableAlgorithms,
  type Algorithm,
  type Library,
  type Source,
} from '@pqc-deps/core';
import { headingAbove, PQC_PATTERN } from './excerpt';
import type { EvidenceDoc } from './fetch/types';
import type { AlgorithmClaim, Evidence, Proposal } from './proposal';

export const MIN_QUOTE_CHARS = 12;

/** Lenient text normalization: case, whitespace, typographic quotes/dashes, markdown emphasis. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/`/g, '') // markdown code spans: models often drop the backticks
    .replace(/[‘’‛´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type QuoteCheck = { ok: true } | { ok: false; reason: string };

/** Quote must appear in the document; "…" / "..." may join fragments that appear in order. */
export function checkQuote(quote: string, doc: EvidenceDoc | undefined): QuoteCheck {
  if (!doc) return { ok: false, reason: 'cites a document id that does not exist' };
  const parts = quote
    .split(/\s*(?:\.\.\.|…|\[…\])\s*/)
    .map(normalizeForMatch)
    .filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total < MIN_QUOTE_CHARS) return { ok: false, reason: 'quote is too short to be meaningful' };
  // Try with whitespace collapsed, then with whitespace removed entirely: models
  // often re-join wrapped changelog lines without the space. Every other
  // character must still match exactly.
  const inOrder = (hay: string, frags: string[]) => {
    let from = 0;
    for (const p of frags) {
      const at = hay.indexOf(p, from);
      if (at === -1) return false;
      from = at + p.length;
    }
    return true;
  };
  const hay = normalizeForMatch(doc.text);
  if (inOrder(hay, parts)) return { ok: true };
  const strip = (s: string) => s.replace(/\s+/g, '');
  if (inOrder(strip(hay), parts.map(strip))) return { ok: true };
  return { ok: false, reason: 'quote not found in the document' };
}

export interface Dropped {
  field: string;
  claim: string;
  reason: string;
}

export interface VerifiedProposal {
  algorithms: Partial<Record<Algorithm, Library['algorithms'][Algorithm]>>;
  roadmap?: Library['roadmap'];
  fips?: Library['fips'];
  overall_status: Library['overall_status'];
  upgrade_notes?: string;
  reviewer_notes: string;
  dropped: Dropped[];
  warnings: string[];
}

function toSources(evidence: Evidence[], docs: Map<string, EvidenceDoc>, today: string): Source[] {
  const seen = new Set<string>();
  return evidence.flatMap((e) => {
    const d = docs.get(e.doc)!;
    const key = `${d.url}|${e.quote}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        url: d.url,
        title: d.title.slice(0, 200),
        kind: d.kind,
        quote: e.quote.trim().slice(0, 1000),
        retrieved: today,
      },
    ];
  });
}

/** The changelog/release section heading above the line where a quote starts. */
export function sectionHeadingFor(text: string, quote: string): string | undefined {
  const probe = normalizeForMatch(quote.split(/\s*(?:\.\.\.|…|\[…\])\s*/)[0] ?? '').slice(0, 40);
  if (!probe) return undefined;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => normalizeForMatch(l).includes(probe));
  if (at === -1) return undefined;
  const h = headingAbove(lines, at);
  return h === undefined ? undefined : lines[h];
}

/** True if a version is stated in the quotes, document titles or the section headings above the quotes. */
function versionMentioned(
  version: string,
  evidence: Evidence[],
  docs: Map<string, EvidenceDoc>,
): boolean {
  const v = normalizeForMatch(version.replace(/^v/i, ''));
  const pattern = new RegExp(`(^|[^0-9.])v?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9])`);
  return evidence.some((e) => {
    const d = docs.get(e.doc);
    const heading = d && sectionHeadingFor(d.text, e.quote);
    return (
      pattern.test(normalizeForMatch(e.quote)) ||
      (d && pattern.test(normalizeForMatch(d.title))) ||
      (heading !== undefined && pattern.test(normalizeForMatch(heading)))
    );
  });
}

/** "On by default" needs a quote about defaults (OpenSSL's "default provider" is a module name, not a setting). */
const DEFAULT_ON_PATTERN =
  /\bby default\b|\bon by default\b|\bdefault (key share|group|groups|list|settings?|configuration|algorithms?)\b|\bdefaults? (now )?include|\bdefault\b(?!\s+(and\s+\w+\s+)?(providers?|implementations?|builds?|modules?|backends?)\b)/i;

/** Each algorithm claim needs a quote that names that algorithm (or its pre-standard name). */
const ALGORITHM_NAME_PATTERN: Record<string, RegExp> = {
  'ml-kem': /ML-?KEM|Kyber|FIPS[ -]?203/i,
  'ml-dsa': /ML-?DSA|Dilithium|FIPS[ -]?204/i,
  'slh-dsa': /SLH-?DSA|SPHINCS|FIPS[ -]?205/i,
  'hybrid-tls': /ML-?KEM|Kyber|hybrid|post[- ]?quantum|\bPQC?\b/i,
  'fn-dsa': /FN-?DSA|Falcon|FIPS[ -]?206/i,
  hqc: /\bHQC\b/i,
};

/** FIPS claims need a quote about validation, not just "FIPS provider". */
const FIPS_PATTERN = /140-[23]|\bcmvp\b|\bcavp\b|certificat|validat/i;

/** Hybrid TLS claims need a quote about TLS key exchange, not just a hybrid KEM. */
const TLS_CONTEXT_PATTERN =
  /\btls\b|\bdtls\b|key ?shares?|supported[_ ]groups?|named groups?|\bgroups? list|handshake|X25519MLKEM768|SecP256r1MLKEM768|SecP384r1MLKEM1024|X25519Kyber768|MLKEM768_X25519/i;

/** Source kinds that can show what a release actually ships. */
const STRONG_KINDS = new Set([
  'release-notes',
  'changelog',
  'docs',
  'maintainer-post',
  'mailing-list',
  'blog',
  'certificate',
]);
const isMergedPr = (d: EvidenceDoc) => d.kind === 'pull-request' && /^State: merged/m.test(d.text);

export function verifyProposal(
  proposal: Proposal,
  docList: EvidenceDoc[],
  lib: Library,
  today: string,
): VerifiedProposal {
  const docs = new Map(docList.map((d) => [d.id, d]));
  const dropped: Dropped[] = [];
  const warnings: string[] = [];

  const keepVerified = (field: string, evidence: Evidence[]) =>
    evidence.filter((e) => {
      const r = checkQuote(e.quote, docs.get(e.doc));
      if (!r.ok)
        dropped.push({ field, claim: `${e.doc}: "${e.quote.slice(0, 160)}"`, reason: r.reason });
      return r.ok;
    });

  const algorithms: VerifiedProposal['algorithms'] = {};
  for (const a of ALGORITHMS) {
    const c: AlgorithmClaim | undefined = proposal.algorithms[a];
    if (!c || c.support === 'unknown') continue;
    let ev = keepVerified(`algorithms.${a}`, c.evidence);
    // At least one quote must name the algorithm (others may add context, e.g. defaults).
    if (ev.length && !ev.some((e) => ALGORITHM_NAME_PATTERN[a]!.test(e.quote))) {
      dropped.push({
        field: `algorithms.${a}`,
        claim: ev.map((e) => `"${e.quote.slice(0, 120)}"`).join('; '),
        reason: `no quote names ${a}`,
      });
      ev = [];
    }
    if (a === 'hybrid-tls') {
      ev = ev.filter((e) => {
        const ok = TLS_CONTEXT_PATTERN.test(e.quote);
        if (!ok)
          dropped.push({
            field: 'algorithms.hybrid-tls',
            claim: `"${e.quote.slice(0, 160)}"`,
            reason: 'quote is not about TLS key exchange (a hybrid KEM alone is not hybrid TLS)',
          });
        return ok;
      });
    }
    if (!ev.length) {
      dropped.push({
        field: `algorithms.${a}`,
        claim: `support: ${c.support}`,
        reason: 'no verifiable evidence, left unknown',
      });
      continue;
    }
    const strong = ev.some((e) => STRONG_KINDS.has(docs.get(e.doc)!.kind));
    const merged = ev.some((e) => isMergedPr(docs.get(e.doc)!));
    if (!strong && !(c.support === 'partial' && merged)) {
      dropped.push({
        field: `algorithms.${a}`,
        claim: `support: ${c.support}`,
        reason:
          c.support === 'partial'
            ? 'only issue or unmerged-PR evidence; nothing shows it shipped'
            : 'only issue/PR evidence; needs release notes, changelog or docs',
      });
      continue;
    }
    let since = c.since_version ?? undefined;
    if (since && !versionMentioned(since, ev, docs)) {
      dropped.push({
        field: `algorithms.${a}.since_version`,
        claim: since,
        reason: 'version not stated in the quoted evidence or document title',
      });
      since = undefined;
    }
    let defaultOn = c.default_enabled;
    if (defaultOn === true && !ev.some((e) => DEFAULT_ON_PATTERN.test(e.quote))) {
      dropped.push({
        field: `algorithms.${a}.default_enabled`,
        claim: 'true',
        reason: 'no quote says it is enabled by default',
      });
      defaultOn = null;
    }
    algorithms[a] = {
      support: c.support,
      ...(since ? { since_version: since } : {}),
      ...(defaultOn !== null ? { default_enabled: defaultOn } : {}),
      ...(c.experimental !== null ? { experimental: c.experimental } : {}),
      // The model's free-text notes are not verified, so they go to the reviewer, not the data.
      sources: toSources(ev, docs, today),
    };
  }

  let roadmap: Library['roadmap'];
  if (proposal.roadmap) {
    const ev = keepVerified('roadmap', proposal.roadmap.evidence);
    if (ev.length) {
      const r = proposal.roadmap;
      const date =
        r.target_date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.target_date)
          ? r.target_date
          : undefined;
      if (r.target_date && !date)
        warnings.push(`Roadmap date "${r.target_date}" isn't YYYY[-MM[-DD]]; dropped.`);
      roadmap = {
        confidence: r.confidence,
        ...(r.target_version ? { target_version: r.target_version } : {}),
        ...(date ? { target_date: date } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
        sources: toSources(ev, docs, today),
      };
    } else {
      dropped.push({
        field: 'roadmap',
        claim: proposal.roadmap.summary ?? 'roadmap',
        reason: 'no verifiable evidence',
      });
    }
  }

  let fips: Library['fips'];
  if (proposal.fips && proposal.fips.status !== 'unknown') {
    const ev = keepVerified('fips', proposal.fips.evidence).filter((e) => {
      const aboutValidation = FIPS_PATTERN.test(e.quote);
      const aboutPqc = PQC_PATTERN.test(e.quote);
      if (!aboutValidation || !aboutPqc)
        dropped.push({
          field: 'fips',
          claim: `"${e.quote.slice(0, 160)}"`,
          reason: !aboutValidation
            ? 'quote does not mention FIPS 140 validation, CMVP or a certificate'
            : 'quote does not say the validation covers PQC algorithms',
        });
      return aboutValidation && aboutPqc;
    });
    if (ev.length) {
      const f = proposal.fips;
      fips = {
        status: f.status,
        ...(f.certificates.length ? { certificates: f.certificates } : {}),
        ...(f.algorithms.length ? { algorithms: f.algorithms } : {}),
        ...(f.notes ? { notes: f.notes } : {}),
        sources: toSources(ev, docs, today),
      };
    } else {
      dropped.push({
        field: 'fips',
        claim: `status: ${proposal.fips.status}`,
        reason: 'no verifiable evidence',
      });
    }
  }

  // "no-plan" needs at least one applicable algorithm with a verified "no".
  let overall = proposal.overall_status;
  if (
    overall === 'no-plan' &&
    !applicableAlgorithms(lib).some((a) => algorithms[a]?.support === 'no')
  ) {
    dropped.push({
      field: 'overall_status',
      claim: 'no-plan',
      reason: 'no verified "not supported" evidence',
    });
    overall = 'unknown';
  }

  return {
    algorithms,
    ...(roadmap ? { roadmap } : {}),
    ...(fips ? { fips } : {}),
    overall_status: overall,
    ...(proposal.upgrade_notes ? { upgrade_notes: proposal.upgrade_notes } : {}),
    reviewer_notes: [
      proposal.reviewer_notes,
      ...Object.entries(proposal.algorithms)
        .filter(([a, c]) => c.notes && algorithms[a as Algorithm])
        .map(([a, c]) => `- ${a} (model note, unverified): ${c.notes}`),
    ]
      .filter(Boolean)
      .join('\n'),
    dropped,
    warnings,
  };
}
