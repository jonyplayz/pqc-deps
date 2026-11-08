/**
 * The shape the LLM must return. Every claim carries evidence: a document id
 * plus a verbatim quote, which verify.ts checks against the fetched text.
 * Nullable instead of optional so the same schema works for structured outputs.
 */
import { z } from 'zod';
import { ALGORITHMS, STATUSES } from '@pqc-deps/core';

export const EvidenceSchema = z.object({
  doc: z.string().describe('Document id, e.g. "D3"'),
  quote: z.string().describe('Short verbatim excerpt copied exactly from that document'),
});

export const AlgorithmClaimSchema = z.object({
  support: z.enum(['yes', 'partial', 'no', 'unknown']),
  since_version: z.string().nullable(),
  default_enabled: z.boolean().nullable(),
  experimental: z.boolean().nullable(),
  notes: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
});

const algorithmShape = Object.fromEntries(
  ALGORITHMS.map((a) => [a, AlgorithmClaimSchema]),
) as Record<(typeof ALGORITHMS)[number], typeof AlgorithmClaimSchema>;

export const ProposalSchema = z.object({
  algorithms: z.object(algorithmShape),
  roadmap: z
    .object({
      target_version: z.string().nullable(),
      target_date: z.string().nullable().describe('YYYY, YYYY-MM or YYYY-MM-DD'),
      confidence: z.enum(['confirmed', 'tentative', 'speculative']),
      summary: z.string().nullable(),
      evidence: z.array(EvidenceSchema),
    })
    .nullable(),
  fips: z
    .object({
      status: z.enum(['validated', 'in-process', 'not-validated', 'unknown']),
      certificates: z.array(z.string()),
      algorithms: z.array(z.enum(ALGORITHMS)),
      notes: z.string().nullable(),
      evidence: z.array(EvidenceSchema),
    })
    .nullable(),
  overall_status: z.enum(STATUSES),
  upgrade_notes: z.string().nullable(),
  reviewer_notes: z.string().describe('Anything a human reviewer should double-check'),
});
export type Proposal = z.infer<typeof ProposalSchema>;
export type AlgorithmClaim = z.infer<typeof AlgorithmClaimSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

/** JSON Schema for structured outputs: every object closed, no $schema key. */
export function proposalJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProposalSchema) as Record<string, unknown>;
  delete schema.$schema;
  const close = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(close);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o.type === 'object') o.additionalProperties = false;
    Object.values(o).forEach(close);
  };
  close(schema);
  return schema;
}
