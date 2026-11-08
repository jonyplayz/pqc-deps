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

const show = (v: unknown) =>
  v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v);

export function mergeProposal(
  existing: Library,
  v: VerifiedProposal,
  today: string,
): { library: Library; changes: FieldChange[]; kept: string[]; warnings: string[] } {
  const kept: string[] = [];
  const warnings: string[] = [];
  const algorithms: Library['algorithms'] = {};

  for (const a of ALGORITHMS) {
    const next = v.algorithms[a];
    const prev = existing.algorithms[a];
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
    ...(v.upgrade_notes ? { upgrade_notes: v.upgrade_notes } : {}),
    last_verified: today,
  });
  if (!roadmap) delete draft.roadmap;

  // n/a is a structural fact about delegation, not something release notes decide.
  if (
    existing.overall_status === 'n/a' &&
    draft.overall_status !== 'n/a' &&
    !Object.keys(v.algorithms).length
  ) {
    draft.overall_status = 'n/a';
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
