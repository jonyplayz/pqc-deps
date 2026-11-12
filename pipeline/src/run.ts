/** Run the pipeline for one library. Dependencies are injected so tests can fake fetch + LLM. */
import { isoToday, lintLibrary, type Library } from '@pqc-deps/core';
import { selectEvidence, type ExcerptOptions, type Excerpted } from './excerpt';
import type { FetchResult } from './fetch/types';
import { LlmRefusalError, type LlmClient } from './llm/types';
import { mergeProposal, type FieldChange } from './merge';
import { buildUserPrompt, extractJson, SYSTEM_PROMPT } from './prompt';
import { ProposalSchema, proposalJsonSchema, type Proposal } from './proposal';
import { verifyProposal, type Dropped } from './verify';

export interface RunDeps {
  fetchEvidence: (lib: Library) => Promise<FetchResult>;
  llm?: LlmClient;
  today?: string;
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

export async function proposeForLibrary(lib: Library, deps: RunDeps): Promise<RunResult> {
  const today = deps.today ?? isoToday();
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
  if (!deps.llm) return base; // dry run

  base.model = deps.llm.label;
  if (!selected.length) {
    base.warnings.push(
      'No fetched document mentions post-quantum cryptography; nothing to propose.',
    );
    return base;
  }

  let proposal: Proposal;
  try {
    proposal = await askModel(deps.llm, lib, selected);
    base.model = deps.llm.label; // the model that answered (it may have fallen back)
  } catch (e) {
    base.error =
      e instanceof LlmRefusalError ? e.message : `LLM step failed: ${(e as Error).message}`;
    return base;
  }

  const verified = verifyProposal(proposal, selected, lib, today);
  const merged = mergeProposal(lib, verified, today);
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
