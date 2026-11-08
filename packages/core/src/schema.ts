/**
 * The library data schema. Single source of truth: the site, the pipeline, the
 * validator and the generated JSON Schema (data/schema/library.schema.json) all
 * derive from this file.
 *
 * Core rule encoded here and in lint.ts: a claim without a cited source must be
 * `unknown`.
 */
import { z } from 'zod';

import {
  STATUSES,
  ECOSYSTEMS,
  REGISTRIES,
  ALGORITHMS,
  UPCOMING_ALGORITHMS,
  DEFAULT_APPLICABLE,
  SUPPORT_LEVELS,
  SOURCE_KINDS,
  type Status,
  type Ecosystem,
  type Registry,
  type Algorithm,
  type SupportLevel,
} from './constants';
export * from './constants';

/** YYYY-MM-DD */
const isoDate = z.iso.date();
/** YYYY, YYYY-MM or YYYY-MM-DD: roadmaps are often only month- or year-precise. */
const fuzzyDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD');
const version = z.string().min(1).max(64);
const id = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'ids are lowercase kebab-case, e.g. "openssl" or "go-crypto"',
  );

export const SourceSchema = z.strictObject({
  url: z.url(),
  title: z.string().min(1),
  kind: z.enum(SOURCE_KINDS),
  /**
   * Verbatim excerpt from the page that supports the claim. The pipeline checks
   * that it really appears in the fetched page; reviewers can Ctrl+F it.
   */
  quote: z.string().min(1).max(1000),
  /** When the source was fetched / read. */
  retrieved: isoDate,
});
export type Source = z.infer<typeof SourceSchema>;

const sources = z.array(SourceSchema).default([]);

export const AlgorithmSupportSchema = z.strictObject({
  support: z.enum(SUPPORT_LEVELS),
  /** First stable version with this support. */
  since_version: version.optional(),
  /** true = on by default, false = opt-in. Omit if unknown. */
  default_enabled: z.boolean().optional(),
  /** Behind an experimental flag, build option or unstable API. */
  experimental: z.boolean().optional(),
  /** Free-form detail, e.g. "only in the EVP API" or "X25519MLKEM768 only". */
  notes: z.string().optional(),
  sources,
});
export type AlgorithmSupport = z.infer<typeof AlgorithmSupportSchema>;

export const RoadmapSchema = z.strictObject({
  target_version: version.optional(),
  target_date: fuzzyDate.optional(),
  /** confirmed = maintainers committed; tentative = "planned for"; speculative = discussed only. */
  confidence: z.enum(['confirmed', 'tentative', 'speculative']),
  summary: z.string().optional(),
  sources: z.array(SourceSchema).min(1),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const FipsSchema = z.strictObject({
  status: z.enum(['validated', 'in-process', 'not-validated', 'unknown']),
  /** CMVP certificate number(s), if validated. */
  certificates: z.array(z.string()).optional(),
  /** Which PQC algorithms the validation covers. */
  algorithms: z.array(z.enum(ALGORITHMS)).optional(),
  notes: z.string().optional(),
  sources,
});
export type Fips = z.infer<typeof FipsSchema>;

export const DelegationSchema = z.strictObject({
  /** id of another library file. */
  id,
  /** e.g. "when built with the openssl feature" or "on Linux". */
  condition: z.string().optional(),
});
export type Delegation = z.infer<typeof DelegationSchema>;

export const PackageNamesSchema = z.partialRecord(
  z.enum(REGISTRIES),
  z.array(z.string().min(1)).min(1),
);

export const LibrarySchema = z.strictObject({
  id,
  name: z.string().min(1),
  ecosystem: z.enum(ECOSYSTEMS),
  description: z.string().max(300).optional(),
  homepage: z.url().optional(),
  repo: z.url().optional(),
  /** Package identifiers per registry: npm name, PyPI name, Go module path, Maven group:artifact... */
  package_names: PackageNamesSchema.default({}),
  /**
   * Registries whose package versions do NOT follow the library's own version
   * numbers (e.g. the cargo `openssl-sys` crate vs OpenSSL releases). The
   * checker won't compare versions against since_version for these.
   */
  separate_versioning: z.array(z.enum(REGISTRIES)).optional(),
  /**
   * Runtimes / standard libraries that the checker should flag automatically
   * for a manifest of this ecosystem (e.g. Node.js crypto for any package.json).
   */
  implicit_for: z.array(z.enum(REGISTRIES)).optional(),
  delegates_to: z.array(DelegationSchema).default([]),
  /** Which algorithms are relevant to this library at all (a JWT lib has no TLS). */
  applicable_algorithms: z.array(z.enum(ALGORITHMS)).optional(),
  overall_status: z.enum(STATUSES),
  algorithms: z.partialRecord(z.enum(ALGORITHMS), AlgorithmSupportSchema).default({}),
  roadmap: RoadmapSchema.optional(),
  fips: FipsSchema.optional(),
  upgrade_notes: z.string().optional(),
  notes: z.string().optional(),
  last_verified: isoDate,
  /** Settings for the evidence pipeline. Not shown on the site. */
  pipeline: z
    .strictObject({
      /** Extra pages to fetch: docs, release-notes pages, non-GitHub changelogs. */
      watch_urls: z.array(z.url()).default([]),
      /** Override the GitHub repo used for releases / issue search ("owner/name"). */
      github: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional(),
      /** Path of the changelog file in the repo, e.g. "CHANGES.md". */
      changelog_path: z.string().optional(),
    })
    .optional(),
});
export type Library = z.infer<typeof LibrarySchema>;
export type LibraryInput = z.input<typeof LibrarySchema>;
