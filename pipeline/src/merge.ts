/**
 * Combine the verified proposal with the existing entry into a new, valid
 * library file. Existing sourced claims are never downgraded to unknown just
 * because this run didn't find evidence for them.
 */
import {
  ALGORITHMS,
  LibrarySchema,
  applicableAlgorithms,
  lintLibrary,
  type Library,
  type Status,
} from '@pqc-deps/core';
import type { VerifiedProposal } from './verify';

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

/** Conservative status derived only from the per-algorithm data. */
export function deriveStatus(lib: Library): Status {
  const s = applicableAlgorithms(lib)
    .map((a) => lib.algorithms[a])
    .filter(Boolean);
  if (s.some((x) => x!.support === 'yes' && x!.default_enabled === true && !x!.experimental))
    return 'ready';
  if (s.some((x) => x!.support === 'yes')) return 'available';
  if (s.some((x) => x!.support === 'yes' || x!.support === 'partial')) return 'partial';
  if (lib.roadmap) return 'planned';
  return lib.overall_status === 'n/a' ? 'n/a' : 'unknown';
}

/**
 * Upgrade guidance built only from verified claims. The model's own wording is
 * not used: in the first real run it invented version numbers there.
 */
export function upgradeNotes(lib: Library): string | undefined {
  const label: Record<string, string> = {
    'ml-kem': 'ML-KEM',
    'ml-dsa': 'ML-DSA',
    'slh-dsa': 'SLH-DSA',
    'hybrid-tls': 'hybrid TLS key exchange',
    'fn-dsa': 'FN-DSA',
    hqc: 'HQC',
  };
  const list = (xs: string[]) =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
  const entries = applicableAlgorithms(lib).flatMap((a) => {
    const s = lib.algorithms[a];
    return s ? [{ a, s }] : [];
  });
  const yes = entries.filter((e) => e.s.support === 'yes');
  const sentences: string[] = [];

  const byVersion = new Map<string, string[]>();
  for (const { a, s } of yes)
    if (s.since_version)
      byVersion.set(s.since_version, [...(byVersion.get(s.since_version) ?? []), label[a]!]);
  const versions = [...byVersion.keys()].sort((x, y) =>
    x.localeCompare(y, undefined, { numeric: true }),
  );
  for (const v of versions)
    sentences.push(`${list(byVersion.get(v)!)}: ${lib.name} ${v} or later.`);
  const undated = yes.filter((e) => !e.s.since_version).map((e) => label[e.a]!);
  if (undated.length)
    sentences.push(
      `${list(undated)}: supported in current releases; the sources don't state the first version.`,
    );

  const defaults = yes.filter((e) => e.s.default_enabled === true).map((e) => label[e.a]!);
  const optIn = yes.filter((e) => e.s.default_enabled === false).map((e) => label[e.a]!);
  if (defaults.length) sentences.push(`On by default: ${list(defaults)}.`);
  if (optIn.length) sentences.push(`Opt-in (must be enabled): ${list(optIn)}.`);

  const partial = entries.filter((e) => e.s.support === 'partial').map((e) => label[e.a]!);
  if (partial.length)
    sentences.push(
      `Partial or experimental: ${list(partial)}; check the notes before relying on it.`,
    );

  if (!sentences.length && lib.roadmap) {
    const t = [lib.roadmap.target_version, lib.roadmap.target_date].filter(Boolean).join(', ');
    sentences.push(`No support yet; a plan exists${t ? ` (target: ${t})` : ''}.`);
  }
  return sentences.length ? sentences.join(' ') : undefined;
}

/** Copy each locked path from `existing` into `draft` (absence included). */
export function applyLocks(draft: Library, existing: Library, paths: string[]): void {
  for (const path of paths) {
    const [top, alg, field] = path.split('.') as [string, string | undefined, string | undefined];
    if (top === 'overall_status') draft.overall_status = existing.overall_status;
    else if (top === 'roadmap' || top === 'fips') {
      const prev = existing[top];
      if (prev === undefined) delete draft[top];
      else (draft as Record<string, unknown>)[top] = prev;
    } else if (top === 'algorithms' && alg) {
      const a = alg as keyof Library['algorithms'];
      const prev = existing.algorithms[a];
      if (!field) {
        if (prev) draft.algorithms[a] = prev;
        else delete draft.algorithms[a];
        continue;
      }
      const cur = draft.algorithms[a];
      if (!cur || (field === 'support' && !prev)) continue;
      const f = field as 'support' | 'since_version' | 'default_enabled' | 'experimental';
      const next: Record<string, unknown> = { ...cur };
      if (prev && prev[f] !== undefined) next[f] = prev[f];
      else delete next[f];
      draft.algorithms[a] = next as typeof cur;
    }
  }
}

const show = (v: unknown) =>
  v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v);

export function mergeProposal(
  existing: Library,
  v: VerifiedProposal,
  today: string,
  /** Written to last_verified; defaults to today's date. */
  verifiedAt: string = today,
): { library: Library; changes: FieldChange[]; kept: string[]; warnings: string[] } {
  const kept: string[] = [];
  const warnings: string[] = [];
  const algorithms: Library['algorithms'] = {};

  for (const a of ALGORITHMS) {
    let next = v.algorithms[a];
    const prev = existing.algorithms[a];
    // Same verdict but this run found fewer details: keep the verified details
    // already on file (e.g. a since-version from an older changelog section).
    if (next && prev && next.support === prev.support) {
      if (!next.since_version && prev.since_version) {
        next = { ...next, since_version: prev.since_version };
        kept.push(
          `algorithms.${a}.since_version ${prev.since_version} (kept; not re-found this run)`,
        );
      }
      if (next.default_enabled === undefined && prev.default_enabled !== undefined) {
        next = { ...next, default_enabled: prev.default_enabled };
        kept.push(`algorithms.${a}.default_enabled (kept; not re-found this run)`);
      }
    }
    if (next) algorithms[a] = next;
    else if (prev && prev.support !== 'unknown') {
      algorithms[a] = prev;
      kept.push(`algorithms.${a} (no new evidence this run; kept the existing sourced claim)`);
    } else if (prev) algorithms[a] = prev;
  }

  const roadmap = v.roadmap ?? existing.roadmap;
  if (!v.roadmap && existing.roadmap) kept.push('roadmap (kept existing)');
  const fips = v.fips ?? existing.fips;
  if (!v.fips && existing.fips && existing.fips.status !== 'unknown')
    kept.push('fips (kept existing)');

  const draft: Library = LibrarySchema.parse({
    ...existing,
    overall_status: v.overall_status,
    algorithms,
    ...(roadmap ? { roadmap } : {}),
    ...(fips ? { fips } : {}),
    last_verified: verifiedAt,
  });
  if (!roadmap) delete draft.roadmap;
  const notes = upgradeNotes(draft);
  if (notes) draft.upgrade_notes = notes;

  // n/a is a structural fact about delegation, not something release notes decide.
  if (
    existing.overall_status === 'n/a' &&
    draft.overall_status !== 'n/a' &&
    !Object.keys(v.algorithms).length
  ) {
    draft.overall_status = 'n/a';
  }

  // "unknown" from this run means "found nothing new", not "the old evidence is wrong".
  if (draft.overall_status === 'unknown' && existing.overall_status !== 'unknown') {
    draft.overall_status = existing.overall_status;
    kept.push(`overall_status "${existing.overall_status}" (the model found no new evidence)`);
  }

  // If overall_status contradicts the data, fall back to the conservative derivation.
  const statusErrors = lintLibrary(draft, today).filter(
    (i) => i.severity === 'error' && i.path === 'overall_status',
  );
  if (statusErrors.length) {
    const derived = deriveStatus(draft);
    warnings.push(
      `Model said overall_status "${draft.overall_status}", which contradicts the verified data (${statusErrors[0]!.message}); using "${derived}".`,
    );
    draft.overall_status = derived;
  }

  // Reviewer locks win over anything this run proposed.
  const locks = existing.pipeline?.locked ?? [];
  if (locks.length) {
    applyLocks(
      draft,
      existing,
      locks.map((l) => l.path),
    );
    for (const l of locks) kept.push(`${l.path} (locked by reviewer: ${l.reason})`);
    const fresh = upgradeNotes(draft);
    if (fresh) draft.upgrade_notes = fresh;
    else delete draft.upgrade_notes;
    const lockErrors = lintLibrary(draft, today).filter((i) => i.severity === 'error');
    if (lockErrors.length) {
      warnings.push(
        `Locked values now contradict the data (${lockErrors.map((i) => `${i.path}: ${i.message}`).join('; ')}); review the locks.`,
      );
    }
  }

  const changes: FieldChange[] = [];
  const cmp = (field: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ field, before: show(before), after: show(after) });
  };
  cmp('overall_status', existing.overall_status, draft.overall_status);
  for (const a of ALGORITHMS) {
    const b = existing.algorithms[a];
    const n = draft.algorithms[a];
    const brief = (x: typeof b) =>
      x && {
        support: x.support,
        since: x.since_version,
        default: x.default_enabled,
        experimental: x.experimental,
        sources: x.sources.length,
      };
    cmp(`algorithms.${a}`, brief(b), brief(n));
  }
  cmp(
    'roadmap',
    existing.roadmap && { ...existing.roadmap, sources: existing.roadmap.sources.length },
    draft.roadmap && { ...draft.roadmap, sources: draft.roadmap.sources.length },
  );
  cmp(
    'fips',
    existing.fips && { ...existing.fips, sources: existing.fips.sources.length },
    draft.fips && { ...draft.fips, sources: draft.fips.sources.length },
  );
  cmp('upgrade_notes', existing.upgrade_notes, draft.upgrade_notes);

  return { library: draft, changes, kept, warnings };
}
