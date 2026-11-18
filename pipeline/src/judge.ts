/**
 * Second opinion: a separate, strict model request that re-reads every claim a
 * run wants to change, with only its quotes and the release they sit under.
 * The first request finds evidence; this one only has to say whether that
 * evidence really shows the claim. Claims it can't confirm are dropped, so the
 * reviewed value on file stays.
 *
 * Mistakes it exists for (all seen in production):
 *  - "Update liboqs (includes e.g. HQC round 3 update)" taken as "HQC since 0.3.0"
 *  - "ML-DSA: Improved testing for ML-DSA" taken as the first ML-DSA release
 *  - "Fix IsSupported tests for ML-KEM" as the only evidence of ML-KEM support
 */
import { z } from 'zod';
import { ALGORITHM_INFO, type Algorithm, type Library } from '@pqc-deps/core';
import { extractJson } from './prompt';
import type { LlmClient } from './llm/types';

export interface JudgeItem {
  key: string;
  algorithm: Algorithm;
  support: 'yes' | 'partial' | 'no';
  since_version?: string;
  default_enabled?: boolean;
  quotes: Array<{ text: string; release?: string }>;
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      key: z.string(),
      supports_claim: z.boolean(),
      version_ok: z.boolean().nullable(),
      default_ok: z.boolean().nullable(),
      reason: z.string(),
    }),
  ),
});
export type Verdict = z.infer<typeof VerdictSchema>['verdicts'][number];

const SYSTEM = `You check claims for a public catalog of post-quantum cryptography support. You are strict: when in doubt, answer false.

For each item you get a library, an algorithm, a claimed support level, and the only evidence: short quotes, each with the release or section it comes from when known. Use nothing else.

Answer per item:
- supports_claim: do the quotes show that THIS library provides the algorithm at the claimed level? "yes" means usable in a stable release; "partial" means experimental, draft-only or limited. A bug fix, test change, refactor, documentation change, dependency update or performance change may only count if it clearly shows the feature already exists in this library; a mention of another product, a proposal or a discussion does not count.
- version_ok: only if a first version is claimed (otherwise null). True only if a quote shows the feature was added or introduced in that version (or the quote is a new-feature entry listed under that version). A change, fix, test, optimisation or default switch in that version is false: it does not show when support began.
- default_ok: only if "on by default" is claimed (otherwise null). True only if a quote says the algorithm is used, offered or preferred by default when the library runs (for example a TLS group offered in the default handshake, or certificates accepted by default). Being in a "default provider", "default build" or "default implementation", or being compiled in / enabled in the build options by default (for example "KEM_x is now enabled by default" in a library's build configuration), is false: that only makes it available, not used.
- reason: one short sentence.

Return JSON: {"verdicts":[{"key":...,"supports_claim":...,"version_ok":...,"default_ok":...,"reason":...}]}`;

export function judgePrompt(lib: Library, items: JudgeItem[]): string {
  return `Library: ${lib.name} (${lib.id})\n\n${items
    .map((it) => {
      const claim = [
        `support: ${it.support}`,
        it.since_version ? `first version: ${it.since_version}` : undefined,
        it.default_enabled ? 'on by default: yes' : undefined,
      ]
        .filter(Boolean)
        .join('; ');
      const quotes = it.quotes
        .map((q) => `  - "${q.text}"${q.release ? ` (from: ${q.release})` : ''}`)
        .join('\n');
      return `[${it.key}] ${ALGORITHM_INFO[it.algorithm].label}: ${claim}\n${quotes}`;
    })
    .join('\n\n')}`;
}

export async function secondOpinion(
  llm: LlmClient,
  lib: Library,
  items: JudgeItem[],
): Promise<Map<string, Verdict>> {
  if (!items.length) return new Map();
  const text = await llm.completeJson({
    system: SYSTEM,
    user: judgePrompt(lib, items),
    schema: z.toJSONSchema(VerdictSchema) as Record<string, unknown>,
  });
  const parsed = VerdictSchema.parse(extractJson(text));
  // Models sometimes echo the key as "[a]" or "a "; match loosely.
  const norm = (k: string) => k.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  const byKey = new Map(parsed.verdicts.map((v) => [norm(v.key), v]));
  const out = new Map<string, Verdict>();
  items.forEach((it, i) => {
    const v =
      byKey.get(norm(it.key)) ??
      (parsed.verdicts.length === items.length ? parsed.verdicts[i] : undefined);
    if (v) out.set(it.key, v);
  });
  return out;
}
