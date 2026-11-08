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
import type { EvidenceDoc } from './fetch/types';
import type { AlgorithmClaim, Evidence, Proposal } from './proposal';

export const MIN_QUOTE_CHARS = 12;

/** Lenient text normalization: case, whitespace, typographic quotes/dashes, markdown emphasis. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‛`´]/g, "'")
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
  const hay = normalizeForMatch(doc.text);
  let from = 0;
  for (const p of parts) {
    const at = hay.indexOf(p, from);
    if (at === -1) return { ok: false, reason: 'quote not found in the document' };
    from = at + p.length;
  }
  return { ok: true };
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

/** True if a version string is stated in the quotes or titles of the evidence. */
function versionMentioned(
  version: string,
  evidence: Evidence[],
  docs: Map<string, EvidenceDoc>,
): boolean {
  const v = normalizeForMatch(version.replace(/^v/i, ''));
  const pattern = new RegExp(`(^|[^0-9.])v?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9])`);
  return evidence.some((e) => {
    const d = docs.get(e.doc);
    return (
      pattern.test(normalizeForMatch(e.quote)) || (d && pattern.test(normalizeForMatch(d.title)))
    );
  });
}

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
    const ev = keepVerified(`algorithms.${a}`, c.evidence);
    if (!ev.length) {
      dropped.push({
        field: `algorithms.${a}`,
        claim: `support: ${c.support}`,
        reason: 'no verifiable evidence, left unknown',
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
    algorithms[a] = {
      support: c.support,
      ...(since ? { since_version: since } : {}),
      ...(c.default_enabled !== null ? { default_enabled: c.default_enabled } : {}),
      ...(c.experimental !== null ? { experimental: c.experimental } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
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
    const ev = keepVerified('fips', proposal.fips.evidence);
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
    reviewer_notes: proposal.reviewer_notes,
    dropped,
    warnings,
  };
}
