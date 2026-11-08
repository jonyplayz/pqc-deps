/** Human-facing labels and descriptions for the status taxonomy. */
import type { Algorithm, Status, SupportLevel } from './schema';

export const STATUS_INFO: Record<Status, { label: string; description: string }> = {
  ready: {
    label: 'Ready',
    description:
      'PQC is supported in a stable release and enabled by default where it applies (for example, hybrid key exchange on by default).',
  },
  available: {
    label: 'Available',
    description: 'PQC is supported in a stable release, but you have to opt in.',
  },
  partial: {
    label: 'Partial',
    description:
      'Only some algorithms are supported (for example, KEM but not signatures), or support is experimental or behind flags.',
  },
  planned: {
    label: 'Planned',
    description: 'Not supported yet, but there is a public plan.',
  },
  'no-plan': {
    label: 'No plan',
    description: 'No support and no public plan found.',
  },
  unknown: {
    label: 'Unknown',
    description: 'Not researched yet, or the evidence is inconclusive.',
  },
  'n/a': {
    label: 'Delegates',
    description:
      'The library does not do asymmetric crypto itself; it delegates to another library. See that library.',
  },
};

export const ALGORITHM_INFO: Record<Algorithm, { label: string; standard: string; kind: string }> =
  {
    'ml-kem': { label: 'ML-KEM', standard: 'FIPS 203', kind: 'Key encapsulation' },
    'ml-dsa': { label: 'ML-DSA', standard: 'FIPS 204', kind: 'Signatures' },
    'slh-dsa': { label: 'SLH-DSA', standard: 'FIPS 205', kind: 'Hash-based signatures' },
    'hybrid-tls': {
      label: 'Hybrid TLS',
      standard: 'e.g. X25519MLKEM768',
      kind: 'TLS key exchange',
    },
    'fn-dsa': { label: 'FN-DSA', standard: 'Upcoming standard', kind: 'Signatures' },
    hqc: { label: 'HQC', standard: 'upcoming', kind: 'Key encapsulation' },
  };

export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  yes: 'Supported',
  partial: 'Partial',
  no: 'Not supported',
  unknown: 'Unknown',
};

/** Sort order for "best first" lists. */
export const STATUS_RANK: Record<Status, number> = {
  ready: 0,
  available: 1,
  partial: 2,
  planned: 3,
  'no-plan': 4,
  'n/a': 5,
  unknown: 6,
};
