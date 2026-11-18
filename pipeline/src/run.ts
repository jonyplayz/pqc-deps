/** Run the pipeline for one library. Dependencies are injected so tests can fake fetch + LLM. */
import { isoNow, isoToday, lintLibrary, type Library } from '@pqc-deps/core';
import { selectEvidence, type ExcerptOptions, type Excerpted } from './excerpt';
import { noPqcCode, totalHits, type CodeSearchResult } from './fetch/codesearch';
import type { FetchResult } from './fetch/types';
import { LlmRefusalError, type LlmClient } from './llm/types';
import { mergeProposal, type FieldChange } from './merge';
import { buildBatchPrompt, buildUserPrompt, extractJson, SYSTEM_PROMPT } from './prompt';
import { BatchProposalSchema, ProposalSchema, proposalJsonSchema, type Proposal } from './proposal';
import { secondOpinion, type JudgeItem } from './judge';
import { sectionHeadingFor, verifyProposal, type Dropped, type VerifiedProposal } from './verify';

export interface RunDeps {
  fetchEvidence: (lib: Library) => Promise<FetchResult>;
  llm?: LlmClient;
  today?: string;
  /** Timestamp written to last_verified (default: now, UTC). */
  now?: string;
  excerpt?: ExcerptOptions;
  /** Look for PQC identifiers in the repository when no document mentions PQC. */
  codeSearch?: (lib: Library) => Promise<CodeSearchResult | undefined>;
  /** Ask a second, strict model request to confirm every claim the run changes. */
  secondOpinion?: boolean;
}

export interface RunResult {
  id: string;
  /** The proposed new file content (undefined in dry runs or when nothing could be proposed). */
  library?: Library;
  changes: FieldChange[];
  kept: string[];
  dropped: Dropped[];
  warnings: string[];
  reviewerNotes?: string;
  docs: Excerpted[];
  docsDropped: number;
  totalFetched: number;
  model?: string;
  error?: string;
}

async function askModel(llm: LlmClient, lib: Library, docs: Excerpted[]): Promise<Proposal> {
  const req = {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(lib, docs),
    schema: proposalJsonSchema(),
  };
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await llm.completeJson(
      attempt === 0
        ? req
        : {
            ...req,
            user: `${req.user}\n\nYour previous answer was invalid (${lastError}). Return valid JSON matching the schema.`,
          },
    );
    try {
      return ProposalSchema.parse(extractJson(text));
    } catch (e) {
      lastError = (e as Error).message.slice(0, 500);
    }
  }
  throw new Error(`Model answer didn't match the proposal schema: ${lastError}`);
}

interface Prepared {
  lib: Library;
  base: RunResult;
  selected: Excerpted[];
  /** False for dry runs and when no document mentions PQC. */
  needsModel: boolean;
}

async function prepare(lib: Library, deps: RunDeps): Promise<Prepared> {
  const fetched = await deps.fetchEvidence(lib);
  const { selected, dropped: docsDropped } = selectEvidence(fetched.docs, deps.excerpt);
  const base: RunResult = {
    id: lib.id,
    changes: [],
    kept: [],
    dropped: [],
    warnings: [...fetched.warnings],
    docs: selected,
    docsDropped,
    totalFetched: fetched.docs.length,
  };
  if (docsDropped)
    base.warnings.push(
      `${docsDropped} matching document(s) left out to stay within the size budget.`,
    );
  if (!deps.llm) return { lib, base, selected, needsModel: false }; // dry run

  base.model = deps.llm.label;
  if (!selected.length) {
    base.warnings.push(
      'No fetched document mentions post-quantum cryptography; nothing to propose from documents.',
    );
    return { lib, base: await fromCodeSearch(lib, base, deps), selected, needsModel: false };
  }
  return { lib, base, selected, needsModel: true };
}

/**
 * No document mentions PQC. A library that never added it has no document
 * saying so, so instead of leaving it "unknown", look at its code: an indexed
 * repository without any PQC identifiers is "no-plan"; one with them needs a
 * human, because the evidence lives somewhere the pipeline didn't read.
 */
async function fromCodeSearch(lib: Library, base: RunResult, deps: RunDeps): Promise<RunResult> {
  if (!deps.codeSearch || lib.overall_status !== 'unknown' || lib.roadmap) return base;
  let cs: CodeSearchResult | undefined;
  try {
    cs = await deps.codeSearch(lib);
  } catch (e) {
    base.warnings.push(`Code search failed: ${(e as Error).message}`);
    return base;
  }
  if (!cs) return base;
  if (totalHits(cs) > 0) {
    const found = Object.entries(cs.terms)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t} (${n})`)
      .join(', ');
    base.warnings.push(
      `The repository has post-quantum code (${found}) but no fetched document describes it. Research it by hand or add watch_urls.`,
    );
    return base;
  }
  if (!noPqcCode(cs)) {
    base.warnings.push('Code search could not confirm the repository is indexed; left unknown.');
    return base;
  }
  const note = `Searched on ${cs.date}: the ${cs.repo} repository has no ML-KEM, ML-DSA, Kyber or Dilithium code, and no fetched release note or document mentions post-quantum cryptography.`;
  return {
    ...base,
    library: {
      ...lib,
      overall_status: 'no-plan',
      notes: lib.notes ? `${lib.notes} ${note}` : note,
      last_verified: deps.now ?? (deps.today ? `${deps.today}T00:00:00Z` : isoNow()),
    },
    changes: [{ field: 'overall_status', before: 'unknown', after: 'no-plan' }],
  };
}

/** Claims this run would add or change, as items for the second opinion. */
function changedClaims(lib: Library, v: VerifiedProposal, docs: Excerpted[]): JudgeItem[] {
  const items: JudgeItem[] = [];
  for (const [a, c] of Object.entries(v.algorithms) as Array<
    [
      keyof Library['algorithms'],
      NonNullable<VerifiedProposal['algorithms'][keyof Library['algorithms']]>,
    ]
  >) {
    if (!c || c.support === 'unknown') continue;
    const prev = lib.algorithms[a];
    const sameSupport = prev?.support === c.support;
    const newVersion = Boolean(c.since_version) && (!sameSupport || !prev?.since_version);
    const newDefault = c.default_enabled === true && (!sameSupport || !prev?.default_enabled);
    if (sameSupport && !newVersion && !newDefault) continue;
    items.push({
      key: a,
      algorithm: a,
      support: c.support as JudgeItem['support'],
      ...(newVersion ? { since_version: c.since_version } : {}),
      ...(newDefault ? { default_enabled: true } : {}),
      quotes: c.sources.map((s) => {
        const d = docs.find((x) => x.url === s.url);
        const heading = d ? sectionHeadingFor(d.text, s.quote) : undefined;
        return {
          text: s.quote,
          release: [s.title, heading].filter(Boolean).join(' / ') || undefined,
        };
      }),
    });
  }
  return items;
}

/** Drop whatever the second opinion can't confirm; the reviewed value on file then stays. */
async function applySecondOpinion(p: Prepared, v: VerifiedProposal, deps: RunDeps): Promise<void> {
  const items = changedClaims(p.lib, v, p.selected);
  if (!items.length) return;
  let verdicts: Awaited<ReturnType<typeof secondOpinion>>;
  try {
    verdicts = await secondOpinion(deps.llm!, p.lib, items);
  } catch (e) {
    // Accuracy first: without a second opinion, changed claims don't go through.
    for (const it of items) {
      delete v.algorithms[it.algorithm];
      v.dropped.push({
        field: `algorithms.${it.algorithm}`,
        claim: it.support,
        reason: `second opinion unavailable (${(e as Error).message.slice(0, 120)}); not changed this run`,
      });
    }
    return;
  }
  for (const it of items) {
    const verdict = verdicts.get(it.key);
    const c = v.algorithms[it.algorithm];
    if (!c) continue;
    if (!verdict || !verdict.supports_claim) {
      delete v.algorithms[it.algorithm];
      v.dropped.push({
        field: `algorithms.${it.algorithm}`,
        claim: it.support,
        reason: `second opinion: ${verdict?.reason ?? 'no verdict returned'}`,
      });
      continue;
    }
    if (it.since_version && verdict.version_ok === false) {
      delete c.since_version;
      v.dropped.push({
        field: `algorithms.${it.algorithm}.since_version`,
        claim: it.since_version,
        reason: `second opinion: ${verdict.reason}`,
      });
    }
    if (it.default_enabled && verdict.default_ok === false) {
      delete c.default_enabled;
      v.dropped.push({
        field: `algorithms.${it.algorithm}.default_enabled`,
        claim: 'true',
        reason: `second opinion: ${verdict.reason}`,
      });
    }
  }
}

async function finish(p: Prepared, proposal: Proposal, deps: RunDeps): Promise<RunResult> {
  const { lib, base, selected } = p;
  const today = deps.today ?? isoToday();
  const verified = verifyProposal(proposal, selected, lib, today);
  if (deps.secondOpinion && deps.llm) await applySecondOpinion(p, verified, deps);
  const merged = mergeProposal(
    lib,
    verified,
    today,
    deps.now ?? (deps.today ? `${deps.today}T00:00:00Z` : isoNow()),
  );
  const lintErrors = lintLibrary(merged.library, today).filter((i) => i.severity === 'error');
  const lintWarnings = lintLibrary(merged.library, today).filter((i) => i.severity === 'warning');
  if (lintErrors.length) {
    base.error = `Proposal fails validation: ${lintErrors.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
    return { ...base, dropped: verified.dropped };
  }
  return {
    ...base,
    library: merged.library,
    changes: merged.changes,
    kept: merged.kept,
    dropped: verified.dropped,
    warnings: [
      ...base.warnings,
      ...verified.warnings,
      ...merged.warnings,
      ...lintWarnings.map((i) => `${i.path}: ${i.message}`),
    ],
    reviewerNotes: verified.reviewer_notes,
  };
}

const failed = (p: Prepared, e: unknown): RunResult => ({
  ...p.base,
  error: e instanceof LlmRefusalError ? e.message : `LLM step failed: ${(e as Error).message}`,
});

export async function proposeForLibrary(lib: Library, deps: RunDeps): Promise<RunResult> {
  const p = await prepare(lib, deps);
  if (!p.needsModel) return p.base;
  try {
    const proposal = await askModel(deps.llm!, lib, p.selected);
    p.base.model = deps.llm!.label; // the model that answered (it may have fallen back)
    return await finish(p, proposal, deps);
  } catch (e) {
    return failed(p, e);
  }
}

// ---------------------------------------------------------------- batches

export interface BatchOptions {
  /** Most libraries per model request (1 = one request per library). */
  batchSize: number;
  /** Most excerpt characters per request, so a batch stays inside token limits. */
  maxBatchChars?: number;
  /** Pause between model requests (free tiers limit requests per minute). */
  delayMs?: number;
}

const excerptChars = (p: Prepared) => p.selected.reduce((n, d) => n + d.excerpt.length, 0);

/** Group items into requests by count and total size. */
export function planBatches<T>(
  items: T[],
  size: (t: T) => number,
  batchSize: number,
  maxChars: number,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    const n = size(it);
    if (cur.length && (cur.length >= batchSize || chars + n > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function askBatch(
  llm: LlmClient,
  items: Prepared[],
): Promise<{ proposals: Map<string, Proposal>; error?: string }> {
  const req = {
    system: SYSTEM_PROMPT,
    user: buildBatchPrompt(items.map((p) => ({ lib: p.lib, docs: p.selected }))),
    schema: proposalJsonSchema(true),
  };
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await llm.completeJson(
      attempt === 0
        ? req
        : {
            ...req,
            user: `${req.user}\n\nYour previous answer was invalid (${lastError}). Return valid JSON matching the schema.`,
          },
    );
    try {
      const parsed = BatchProposalSchema.parse(extractJson(text));
      const proposals = new Map<string, Proposal>();
      for (const { library_id, ...proposal } of parsed.results) proposals.set(library_id, proposal);
      return { proposals };
    } catch (e) {
      lastError = (e as Error).message.slice(0, 500);
    }
  }
  return {
    proposals: new Map(),
    error: `Model answer didn't match the batch schema: ${lastError}`,
  };
}

/**
 * Run many libraries, asking the model about several at once. Each library is
 * still verified on its own against its own documents, exactly as in
 * proposeForLibrary; batching only saves requests.
 */
export async function proposeForLibraries(
  libs: Library[],
  deps: RunDeps,
  opts: BatchOptions,
): Promise<RunResult[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const prepared: Prepared[] = [];
  for (const lib of libs) prepared.push(await prepare(lib, deps));
  const results = new Map<string, RunResult>();
  for (const p of prepared) if (!p.needsModel) results.set(p.lib.id, p.base);

  const batches = planBatches(
    prepared.filter((p) => p.needsModel),
    excerptChars,
    Math.max(1, opts.batchSize),
    opts.maxBatchChars ?? 300_000,
  );
  let calls = 0;
  const pause = async () => {
    if (calls++ && opts.delayMs) await sleep(opts.delayMs);
  };
  for (const batch of batches) {
    if (batch.length === 1) {
      await pause();
      const p = batch[0]!;
      try {
        const proposal = await askModel(deps.llm!, p.lib, p.selected);
        p.base.model = deps.llm!.label;
        results.set(p.lib.id, await finish(p, proposal, deps));
      } catch (e) {
        results.set(p.lib.id, failed(p, e));
      }
      continue;
    }
    let pending = batch;
    // One more request for libraries the model left out of its answer.
    for (let round = 0; round < 2 && pending.length; round++) {
      await pause();
      let answer: { proposals: Map<string, Proposal>; error?: string };
      try {
        answer = await askBatch(deps.llm!, pending);
      } catch (e) {
        for (const p of pending) results.set(p.lib.id, failed(p, e));
        break;
      }
      const missing: Prepared[] = [];
      for (const p of pending) {
        const proposal = answer.proposals.get(p.lib.id);
        if (proposal) {
          p.base.model = deps.llm!.label;
          results.set(p.lib.id, await finish(p, proposal, deps));
        } else if (round === 0 && !answer.error) {
          missing.push(p);
        } else {
          results.set(p.lib.id, {
            ...p.base,
            error: answer.error ?? 'The model left this library out of its batch answer.',
          });
        }
      }
      pending = missing;
    }
  }
  return libs.map((l) => results.get(l.id)!);
}
