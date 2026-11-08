/**
 * Plain constants and types with no runtime dependencies, so browser code
 * (the manifest checker) can import them without pulling in Zod.
 */
export const STATUSES = [
  'ready',
  'available',
  'partial',
  'planned',
  'no-plan',
  'unknown',
  'n/a',
] as const;
export type Status = (typeof STATUSES)[number];

export const ECOSYSTEMS = [
  'c-cpp',
  'go',
  'rust',
  'jvm',
  'python',
  'javascript',
  'dotnet',
  'platform',
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** Package registries the manifest checker can match against. */
export const REGISTRIES = ['npm', 'pypi', 'go', 'maven', 'cargo', 'nuget'] as const;
export type Registry = (typeof REGISTRIES)[number];

export const ALGORITHMS = ['ml-kem', 'ml-dsa', 'slh-dsa', 'hybrid-tls', 'fn-dsa', 'hqc'] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

/** Algorithms whose standards are not final yet. Shown as "upcoming" in the UI. */
export const UPCOMING_ALGORITHMS: readonly Algorithm[] = ['fn-dsa', 'hqc'];

/** Default `applicable_algorithms` when a file does not set it. */
export const DEFAULT_APPLICABLE: readonly Algorithm[] = [
  'ml-kem',
  'ml-dsa',
  'slh-dsa',
  'hybrid-tls',
];

export const SUPPORT_LEVELS = ['yes', 'partial', 'no', 'unknown'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const SOURCE_KINDS = [
  'release-notes',
  'changelog',
  'docs',
  'commit',
  'issue',
  'pull-request',
  'maintainer-post',
  'mailing-list',
  'blog',
  'certificate',
  'other',
] as const;

/** The algorithms relevant to a library (falls back to DEFAULT_APPLICABLE). */
export function applicableAlgorithms(lib: {
  applicable_algorithms?: readonly Algorithm[] | undefined;
}): readonly Algorithm[] {
  return lib.applicable_algorithms ?? DEFAULT_APPLICABLE;
}
