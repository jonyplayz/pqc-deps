import type { SOURCE_KINDS } from '@pqc-deps/core';

export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One fetched page/release/issue the LLM may cite. */
export interface EvidenceDoc {
  /** Short id used in the prompt and in citations, e.g. "D3". Assigned after fetching. */
  id: string;
  url: string;
  title: string;
  kind: SourceKind;
  /** Full plain text. Quotes are verified against this. */
  text: string;
  /** ISO date if known (release date, issue update date). */
  date?: string;
}

export type FetchedDoc = Omit<EvidenceDoc, 'id'>;

export interface FetchResult {
  docs: FetchedDoc[];
  /** Non-fatal problems (404 changelog, rate limit, unreachable URL). */
  warnings: string[];
}
