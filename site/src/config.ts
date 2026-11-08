export const SITE = {
  name: 'PQC Deps',
  tagline: 'Post-quantum readiness for the libraries you depend on',
  description:
    'Track whether popular open-source crypto libraries support ML-KEM, ML-DSA, SLH-DSA and hybrid TLS, since which version, and what is planned. Every claim links to a source.',
  repoUrl: 'https://github.com/jonyplayz/pqc-deps',
  /** Entries whose last_verified is older than this are flagged as stale. */
  staleAfterDays: 90,
};

export function correctionUrl(libraryId?: string): string {
  const params = new URLSearchParams({ template: 'correction.yml' });
  if (libraryId) {
    params.set('title', `[Correction] ${libraryId}`);
    params.set('library', libraryId);
  }
  return `${SITE.repoUrl}/issues/new?${params}`;
}

export function editUrl(libraryId: string): string {
  return `${SITE.repoUrl}/edit/main/data/libraries/${libraryId}.yaml`;
}
