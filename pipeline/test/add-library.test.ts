import { describe, expect, it } from 'vitest';
import { LibrarySchema, type Library } from '@pqc-deps/core';
import {
  normalizeInput,
  parseEcosystem,
  parseIssueForm,
  parsePackageSpecs,
  rawInputFromEnv,
  rawInputFromIssue,
  slugify,
} from '../src/add-library/input';
import { buildSkeleton } from '../src/add-library/skeleton';
import { libraryToYaml } from '../src/output';
import { parseLibraryYaml } from '@pqc-deps/core';

const TODAY = '2026-11-09';
const existing: Library[] = [
  LibrarySchema.parse({
    id: 'openssl',
    name: 'OpenSSL',
    ecosystem: 'c-cpp',
    repo: 'https://github.com/openssl/openssl',
    overall_status: 'unknown',
    last_verified: TODAY,
  }),
  LibrarySchema.parse({
    id: 'rustcrypto-ml-dsa',
    name: 'RustCrypto ml-dsa',
    ecosystem: 'rust',
    repo: 'https://github.com/RustCrypto/signatures',
    package_names: { cargo: ['ml-dsa'] },
    overall_status: 'unknown',
    last_verified: TODAY,
  }),
];

describe('slugify', () => {
  it.each([
    ['Botan', 'botan'],
    ['Bouncy Castle (Java)', 'bouncy-castle-java'],
    ['  Crème / brûlée 2  ', 'creme-brulee-2'],
    ['golang.org/x/crypto', 'golang-org-x-crypto'],
  ])('%s → %s', (a, b) => expect(slugify(a)).toBe(b));
});

describe('parsePackageSpecs', () => {
  it('accepts registry:name in many layouts', () => {
    const { packages, errors } = parsePackageSpecs(
      'npm:jose\npypi: cryptography, maven:org.bouncycastle:bcprov-jdk18on `cargo:ring` npm:@noble/post-quantum go:golang.org/x/crypto',
    );
    expect(errors).toEqual([]);
    expect(packages).toEqual({
      npm: ['jose', '@noble/post-quantum'],
      pypi: ['cryptography'],
      maven: ['org.bouncycastle:bcprov-jdk18on'],
      cargo: ['ring'],
      go: ['golang.org/x/crypto'],
    });
  });
  it('rejects unknown registries and malformed names', () => {
    const { errors } = parsePackageSpecs('jose foo:bar npm:has$dollar maven:noartifact');
    expect(errors).toHaveLength(4);
  });
  it('deduplicates', () => {
    expect(parsePackageSpecs('npm:jose npm:jose').packages).toEqual({ npm: ['jose'] });
  });
});

describe('parseEcosystem', () => {
  it('accepts ids and labels', () => {
    expect(parseEcosystem('rust')).toBe('rust');
    expect(parseEcosystem('Java / JVM')).toBe('jvm');
    expect(parseEcosystem('JavaScript / Node')).toBe('javascript');
    expect(parseEcosystem('cobol')).toBeUndefined();
  });
});

describe('normalizeInput', () => {
  it('builds a valid input', () => {
    const { input, errors } = normalizeInput({
      name: 'Botan',
      ecosystem: 'c-cpp',
      repo: 'https://github.com/randombit/botan',
      packages: 'pypi:botan3',
      applicable: 'ml-kem, ml-dsa,slh-dsa',
      watch_urls: 'https://botan.randombit.net/news.html',
    });
    expect(errors).toEqual([]);
    expect(input).toMatchObject({
      name: 'Botan',
      package_names: { pypi: ['botan3'] },
      applicable_algorithms: ['ml-kem', 'ml-dsa', 'slh-dsa'],
      watch_urls: ['https://botan.randombit.net/news.html'],
      delegates_to: [],
    });
  });
  it('rejects non-https URLs, bad ecosystems, algorithms and ids', () => {
    const { input, errors } = normalizeInput({
      id: 'Bad Id',
      name: 'X',
      ecosystem: 'cobol',
      repo: 'http://example.com/x',
      applicable: 'ml-kem rsa',
    });
    expect(input).toBeUndefined();
    const text = errors.join('\n');
    expect(text).toMatch(/ecosystem/);
    expect(text).toMatch(/repo.*https/);
    expect(text).toMatch(/applicable_algorithms/);
    expect(text).toMatch(/id/);
    expect(text).toMatch(/name/);
  });
  it('treats "_No response_" as empty', () => {
    const { input } = normalizeInput({
      name: 'Botan',
      ecosystem: 'c-cpp',
      repo: 'https://github.com/randombit/botan',
      homepage: '_No response_',
      packages: '_No response_',
    });
    expect(input?.homepage).toBeUndefined();
    expect(input?.package_names).toEqual({});
  });
});

describe('issue form and env inputs', () => {
  const body = `### Library name

Botan

### Ecosystem

C / C++

### Source repository URL

https://github.com/randombit/botan

### Homepage

_No response_

### Package names

pypi:botan3

### Anything else?

It has ML-KEM.`;

  it('parses issue-form sections', () => {
    expect(parseIssueForm(body)).toMatchObject({
      'Library name': 'Botan',
      Ecosystem: 'C / C++',
      Homepage: '',
      'Anything else?': 'It has ML-KEM.',
    });
  });
  it('maps form fields to input', () => {
    const { input, errors } = normalizeInput(rawInputFromIssue(body));
    expect(errors).toEqual([]);
    expect(input).toMatchObject({
      name: 'Botan',
      ecosystem: 'c-cpp',
      package_names: { pypi: ['botan3'] },
    });
  });
  it('reads ADD_* environment variables', () => {
    expect(
      rawInputFromEnv({ ADD_NAME: 'Botan', ADD_REPO: 'https://x', ADD_PACKAGES: 'npm:a' }),
    ).toMatchObject({
      name: 'Botan',
      repo: 'https://x',
      packages: 'npm:a',
    });
  });
});

describe('buildSkeleton', () => {
  const ok = normalizeInput({
    name: 'Botan',
    ecosystem: 'c-cpp',
    repo: 'https://github.com/randombit/botan',
    packages: 'pypi:botan3',
    delegates: '',
  }).input!;

  it('creates an unknown entry that round-trips through YAML', () => {
    const { library, errors } = buildSkeleton(ok, existing, TODAY);
    expect(errors).toEqual([]);
    expect(library).toMatchObject({ id: 'botan', overall_status: 'unknown', last_verified: TODAY });
    const parsed = parseLibraryYaml(libraryToYaml(library!), 'botan.yaml');
    expect(parsed.ok).toBe(true);
  });

  it('refuses duplicates and unknown delegation targets', () => {
    const dupId = buildSkeleton({ ...ok, name: 'OpenSSL' }, existing, TODAY);
    expect(dupId.errors.join()).toMatch(/already in the catalog/);
    const dupPkg = buildSkeleton({ ...ok, package_names: { cargo: ['ml_dsa'] } }, existing, TODAY);
    expect(dupPkg.errors.join()).toMatch(/already belongs to "rustcrypto-ml-dsa"/);
    const badDelegate = buildSkeleton({ ...ok, delegates_to: ['nope'] }, existing, TODAY);
    expect(badDelegate.errors.join()).toMatch(/no catalog entry "nope"/);
  });

  it('only warns when a repo is shared with another entry', () => {
    const r = buildSkeleton(
      {
        ...ok,
        name: 'RustCrypto slh-dsa',
        repo: 'https://github.com/RustCrypto/signatures',
        package_names: { cargo: ['slh-dsa'] },
      },
      existing,
      TODAY,
    );
    expect(r.errors).toEqual([]);
    expect(r.library?.id).toBe('rustcrypto-slh-dsa');
    expect(r.warnings.join()).toMatch(/also the repo of "rustcrypto-ml-dsa"/);
  });

  it('accepts a valid delegation and stores watch URLs in the pipeline config', () => {
    const r = buildSkeleton(
      { ...ok, delegates_to: ['openssl'], watch_urls: ['https://botan.randombit.net/news.html'] },
      existing,
      TODAY,
    );
    expect(r.library?.delegates_to).toEqual([{ id: 'openssl' }]);
    expect(r.library?.pipeline?.watch_urls).toEqual(['https://botan.randombit.net/news.html']);
  });
});
