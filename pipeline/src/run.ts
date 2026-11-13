/** Run the pipeline for one library. Dependencies are injected so tests can fake fetch + LLM. */
import { isoNow, isoToday, lintLibrary, type Library } from '@pqc-deps/core';
import { selectEvidence, type ExcerptOptions, type Excerpted } from './excerpt';
import type { FetchResult } from './fetch/types';
import { LlmRefusalError, type LlmClient } from './llm/types';
import { mergeProposal, type FieldChange } from './merge';
import { buildBatchPrompt, buildUserPrompt, extractJson, SYSTEM_PROMPT } from './prompt';
import { BatchProposalSchema, ProposalSchema, proposalJsonSchema, type Proposal } from './proposal';
import { verifyProposal, type Dropped } from './verify';

export interface RunDeps {
  fetchEvidence: (lib: Library) => Promise<FetchResult>;
  llm?: LlmClient;
  today?: string;
  /** Timestamp written to last_verified (default: now, UTC). */
  now?: string;
  excerpt?: ExcerptOptions;
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
      'No fetched document mentions post-quantum cryptography; nothing to propose.',
    );
    return { lib, base, selected, needsModel: false };
  }
  return { lib, base, selected, needsModel: true };
}

function finish(p: Prepared, proposal: Proposal, deps: RunDeps): RunResult {
  const { lib, base, selected } = p;
  const today = deps.today ?? isoToday();
  const verified = verifyProposal(proposal, selected, lib, today);
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
    return finish(p, proposal, deps);
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
        results.set(p.lib.id, finish(p, proposal, deps));
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
          results.set(p.lib.id, finish(p, proposal, deps));
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
