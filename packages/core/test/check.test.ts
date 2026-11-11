import { describe, expect, it } from 'vitest';
import { LibrarySchema, type Library, type LibraryInput } from '../src/schema';
import {
  checkManifest,
  compareVersions,
  indexCatalog,
  looksCryptoRelated,
  lowerBound,
  normalizeName,
  parseManifest,
} from '../src/check';

describe('compareVersions', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['1.10.0', '1.9.9', 1],
    ['v0.31.0', '0.30.0', 1],
    ['3.5', '3.5.0', 0],
    ['1.0.0-rc1', '1.0.0', -1],
    ['4.1.115.Final', '4.1.115', 0],
    ['1.79', '1.80', -1],
    ['2.0.0b1', '2.0.0', -1],
  ])('%s vs %s → %i', (a, b, r) => {
    expect(compareVersions(a, b)).toBe(r);
  });
  it('returns undefined for non-versions', () => {
    expect(compareVersions('latest', '1.0')).toBeUndefined();
  });
});

describe('lowerBound', () => {
  it.each([
    ['^1.2.3', '1.2.3'],
    ['~1.2.3', '1.2.3'],
    ['>=42,<45', '42'],
    ['>= 42, < 45', '42'],
    ['>=1.2.7 <1.3.0', '1.2.7'],
    ['~=2.8', '2.8'],
    ['==43.0.1', '43.0.1'],
    ['1.2.x', '1.2'],
    ['0.23', '0.23'],
    ['[1.0,2.0)', '1.0'],
    ['^1.0.0 || ^2.0.0', '1.0.0'],
    ['1.2.3 - 2.0.0', '1.2.3'],
    ['*', undefined],
    ['<2', undefined],
    ['(,1.0]', undefined],
    ['latest', undefined],
  ])('%s → %s', (spec, lb) => {
    expect(lowerBound(spec)).toBe(lb);
  });
});

describe('normalizeName', () => {
  it('follows registry rules', () => {
    expect(normalizeName('pypi', 'PyJWT')).toBe('pyjwt');
    expect(normalizeName('pypi', 'zope.interface')).toBe('zope-interface');
    expect(normalizeName('cargo', 'openssl_sys')).toBe('openssl-sys');
    expect(normalizeName('go', 'github.com/golang-jwt/jwt/v5')).toBe('github.com/golang-jwt/jwt');
    expect(normalizeName('npm', '@Panva/Jose')).toBe('@panva/jose');
  });
});

describe('looksCryptoRelated', () => {
  it.each([
    'jsonwebtoken',
    'pyjwt',
    'cryptography',
    'org.bouncycastle:bcprov-jdk18on',
    'rustls',
    'ring',
    'node-forge',
    'paramiko',
  ])('%s → yes', (n) => expect(looksCryptoRelated(n)).toBe(true));
  it.each(['lodash', 'string-width', 'express', 'pytest', 'serde', 'spring-boot-starter-web'])(
    '%s → no',
    (n) => expect(looksCryptoRelated(n)).toBe(false),
  );
});

// --- checkManifest against a small fictional catalog ---------------------------------
const src = {
  url: 'https://example.com',
  title: 't',
  kind: 'docs',
  quote: 'q',
  retrieved: '2026-01-01',
} as const;
const L = (o: Partial<LibraryInput> & Pick<LibraryInput, 'id'>): Library =>
  LibrarySchema.parse({
    name: o.id,
    ecosystem: 'javascript',
    overall_status: 'unknown',
    last_verified: '2026-01-01',
    ...o,
  });

const catalog = [
  L({
    id: 'tlslib',
    ecosystem: 'c-cpp',
    package_names: { npm: ['tlslib'], cargo: ['tlslib-sys'] },
    separate_versioning: ['cargo'],
    overall_status: 'ready',
    algorithms: {
      'hybrid-tls': {
        support: 'yes',
        since_version: '3.5.0',
        default_enabled: true,
        sources: [src],
      },
      'ml-kem': { support: 'yes', since_version: '3.5.0', sources: [src] },
      'ml-dsa': { support: 'yes', since_version: '3.6.0', sources: [src] },
    },
  }),
  L({
    id: 'jwtlib',
    package_names: { npm: ['jwtlib'] },
    overall_status: 'n/a',
    delegates_to: [{ id: 'runtime' }],
  }),
  L({
    id: 'runtime',
    ecosystem: 'platform',
    implicit_for: ['npm'],
    delegates_to: [{ id: 'tlslib' }],
    overall_status: 'available',
    algorithms: { 'ml-kem': { support: 'yes', since_version: '24.0.0', sources: [src] } },
  }),
  L({
    id: 'planned-lib',
    package_names: { npm: ['planned-lib'] },
    overall_status: 'planned',
    roadmap: { confidence: 'tentative', sources: [src] },
  }),
  L({
    id: 'x-ssh',
    ecosystem: 'go',
    package_names: { go: ['golang.org/x/crypto/ssh'] },
    overall_status: 'available',
    algorithms: { 'hybrid-tls': { support: 'yes', since_version: 'v0.30.0', sources: [src] } },
    applicable_algorithms: ['hybrid-tls'],
  }),
];
const index = indexCatalog(catalog);
const run = (text: string, filename: string) =>
  checkManifest(parseManifest(text, { filename }), index);
const find = (r: ReturnType<typeof run>, id: string) => r.findings.find((f) => f.library.id === id);

describe('checkManifest', () => {
  it('flags exact versions that predate support as upgrades', () => {
    const r = run(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { tlslib: '*' } },
          'node_modules/tlslib': { version: '3.4.9' },
        },
      }),
      'package-lock.json',
    );
    expect(find(r, 'tlslib')).toMatchObject({
      verdict: 'upgrade',
      upgradeTo: '3.5.0',
      algorithms: ['ml-kem', 'hybrid-tls'],
    });
  });

  it('accepts versions at or above the baseline', () => {
    const r = run(JSON.stringify({ dependencies: { tlslib: '^3.5.1' } }), 'package.json');
    expect(find(r, 'tlslib')!.verdict).toBe('ok');
  });

  it('ranges whose lower bound is too old say "check installed"', () => {
    const r = run(JSON.stringify({ dependencies: { tlslib: '^3.0.0' } }), 'package.json');
    expect(find(r, 'tlslib')).toMatchObject({ verdict: 'check-installed', upgradeTo: '3.5.0' });
  });

  it('does not compare versions for separately versioned bindings', () => {
    const r = run('[dependencies]\ntlslib-sys = "0.9"\n', 'Cargo.toml');
    expect(find(r, 'tlslib')!.verdict).toBe('not-comparable');
  });

  it('shows delegation chains and adds implicit runtimes with the manifest runtime version', () => {
    const r = run(
      JSON.stringify({ engines: { node: '>=22' }, dependencies: { jwtlib: '1.0.0' } }),
      'package.json',
    );
    const jwt = find(r, 'jwtlib')!;
    expect(jwt.verdict).toBe('delegated');
    expect(jwt.chain[0]!.library.id).toBe('runtime');
    expect(jwt.chain[0]!.children[0]!.library.id).toBe('tlslib');
    const rt = find(r, 'runtime')!;
    expect(rt).toMatchObject({
      matchedBy: 'runtime',
      verdict: 'check-installed',
      upgradeTo: '24.0.0',
    });
    expect(rt.note).toMatch(/node >=22/);
  });

  it('reports not-yet for planned libraries', () => {
    const r = run(JSON.stringify({ dependencies: { 'planned-lib': '1.0.0' } }), 'package.json');
    expect(find(r, 'planned-lib')!.verdict).toBe('not-yet');
  });

  it('matches Go packages inside a required module', () => {
    const r = run('module m\n\ngo 1.24\n\nrequire golang.org/x/crypto v0.29.0\n', 'go.mod');
    const f = find(r, 'x-ssh')!;
    expect(f).toMatchObject({ matchedBy: 'module', verdict: 'upgrade', upgradeTo: 'v0.30.0' });
    expect(f.note).toContain('golang.org/x/crypto/ssh');
  });

  it('reports both a Go module entry and package entries inside it', () => {
    const idx = indexCatalog([
      ...catalog,
      L({ id: 'x-crypto', ecosystem: 'go', package_names: { go: ['golang.org/x/crypto'] } }),
    ]);
    const gomod = 'module m\n\nrequire golang.org/x/crypto v0.29.0\n';
    const r = checkManifest(parseManifest(gomod, { filename: 'go.mod' }), idx);
    expect(r.findings.map((f) => [f.library.id, f.matchedBy]).sort()).toEqual([
      ['x-crypto', 'package'],
      ['x-ssh', 'module'],
    ]);
  });

  it('splits unmatched dependencies into possibly-crypto and the rest', () => {
    const r = run(
      JSON.stringify({ dependencies: { 'node-forge': '1', lodash: '4' } }),
      'package.json',
    );
    expect(r.possiblyCrypto.map((d) => d.name)).toEqual(['node-forge']);
    expect(r.untracked.map((d) => d.name)).toEqual(['lodash']);
  });

  it('sorts actionable findings first and counts statuses', () => {
    const r = run(
      JSON.stringify({
        dependencies: { tlslib: '3.6.0', 'planned-lib': '1.0.0', jwtlib: '1.0.0' },
      }),
      'package.json',
    );
    expect(r.findings.map((f) => f.verdict)).toEqual([
      'not-yet',
      'version-unknown',
      'delegated',
      'ok',
    ]);
    expect(r.statusCounts).toEqual({ ready: 1, planned: 1, 'n/a': 1, available: 1 });
  });
});
