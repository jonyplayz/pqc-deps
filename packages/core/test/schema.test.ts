import { describe, expect, it } from 'vitest';
import {
  LibrarySchema,
  lintLibrary,
  lintCatalog,
  type LibraryInput,
  type Library,
} from '../src/index';

const src = {
  url: 'https://example.com/notes',
  title: 'Notes',
  kind: 'release-notes',
  quote: 'Added ML-KEM.',
  retrieved: '2026-01-01',
} as const;

function lib(overrides: Partial<LibraryInput> = {}): Library {
  return LibrarySchema.parse({
    id: 'demo',
    name: 'Demo',
    ecosystem: 'go',
    overall_status: 'unknown',
    last_verified: '2026-01-01',
    ...overrides,
  });
}
const TODAY = '2026-06-01';
const errors = (l: Library) => lintLibrary(l, TODAY).filter((i) => i.severity === 'error');

describe('schema', () => {
  it('accepts a minimal unknown entry and fills defaults', () => {
    const l = lib();
    expect(l.algorithms).toEqual({});
    expect(l.delegates_to).toEqual([]);
    expect(errors(l)).toEqual([]);
  });

  it('rejects unknown fields (catches typos)', () => {
    expect(() => lib({ overal_status: 'ready' } as never)).toThrow();
  });

  it('rejects bad ids, statuses and dates', () => {
    expect(() => lib({ id: 'Open SSL' })).toThrow();
    expect(() => lib({ overall_status: 'done' as never })).toThrow();
    expect(() => lib({ last_verified: '01/02/2026' })).toThrow();
  });

  it('requires a quote on every source', () => {
    const { quote: _q, ...noQuote } = src;
    expect(() =>
      lib({ algorithms: { 'ml-kem': { support: 'yes', sources: [noQuote as never] } } }),
    ).toThrow();
  });

  it('accepts fuzzy roadmap dates', () => {
    for (const d of ['2027', '2027-03', '2027-03-15']) {
      expect(() =>
        lib({ roadmap: { target_date: d, confidence: 'tentative', sources: [src] } }),
      ).not.toThrow();
    }
    expect(() =>
      lib({ roadmap: { target_date: 'Q1 2027', confidence: 'tentative', sources: [src] } }),
    ).toThrow();
  });

  it('requires roadmap sources', () => {
    expect(() => lib({ roadmap: { confidence: 'confirmed', sources: [] } })).toThrow();
  });
});

describe('lint: evidence rule', () => {
  it('flags claims without sources', () => {
    const l = lib({ algorithms: { 'ml-kem': { support: 'yes', since_version: '1.0' } } });
    expect(errors(l).map((e) => e.path)).toContain('algorithms.ml-kem');
  });
  it('allows unknown without sources', () => {
    expect(errors(lib({ algorithms: { 'ml-kem': { support: 'unknown' } } }))).toEqual([]);
  });
  it('flags FIPS claims without sources', () => {
    expect(errors(lib({ fips: { status: 'validated' } })).map((e) => e.path)).toContain('fips');
  });
  it('flags future dates', () => {
    expect(errors(lib({ last_verified: '2027-01-01' })).length).toBe(1);
  });
});

describe('lint: overall_status consistency', () => {
  const yes = (extra = {}) => ({
    support: 'yes' as const,
    since_version: '1.0',
    sources: [src],
    ...extra,
  });

  it('ready requires default-on, non-experimental support', () => {
    expect(errors(lib({ overall_status: 'ready', algorithms: { 'ml-kem': yes() } }))).not.toEqual(
      [],
    );
    expect(
      errors(
        lib({
          overall_status: 'ready',
          algorithms: { 'hybrid-tls': yes({ default_enabled: true }) },
        }),
      ),
    ).toEqual([]);
    expect(
      errors(
        lib({
          overall_status: 'ready',
          algorithms: { 'hybrid-tls': yes({ default_enabled: true, experimental: true }) },
        }),
      ),
    ).not.toEqual([]);
  });

  it('ready ignores algorithms that are not applicable', () => {
    const l = lib({
      overall_status: 'ready',
      applicable_algorithms: ['ml-dsa'],
      algorithms: { 'hybrid-tls': yes({ default_enabled: true }) },
    });
    expect(errors(l)).not.toEqual([]);
  });

  it('available requires a supported algorithm', () => {
    expect(errors(lib({ overall_status: 'available' }))).not.toEqual([]);
    expect(errors(lib({ overall_status: 'available', algorithms: { 'ml-kem': yes() } }))).toEqual(
      [],
    );
  });

  it('partial accepts partial support', () => {
    const l = lib({
      overall_status: 'partial',
      algorithms: { 'ml-kem': { support: 'partial', sources: [src] } },
    });
    expect(errors(l)).toEqual([]);
  });

  it('planned requires a roadmap; no-plan forbids one', () => {
    expect(errors(lib({ overall_status: 'planned' }))).not.toEqual([]);
    const roadmap = { confidence: 'confirmed' as const, sources: [src] };
    expect(errors(lib({ overall_status: 'planned', roadmap }))).toEqual([]);
    expect(errors(lib({ overall_status: 'no-plan', roadmap }))).not.toEqual([]);
  });

  it('n/a requires delegates_to', () => {
    expect(errors(lib({ overall_status: 'n/a' }))).not.toEqual([]);
    expect(errors(lib({ overall_status: 'n/a', delegates_to: [{ id: 'other' }] }))).toEqual([]);
  });
});

describe('lintCatalog', () => {
  it('flags missing delegation targets', () => {
    const issues = lintCatalog([lib({ delegates_to: [{ id: 'nope' }] })]);
    expect(issues[0]?.message).toMatch(/unknown library/);
  });
  it('flags delegation cycles once', () => {
    const issues = lintCatalog([
      lib({ id: 'aa', delegates_to: [{ id: 'bb' }] }),
      lib({ id: 'bb', delegates_to: [{ id: 'cc' }] }),
      lib({ id: 'cc', delegates_to: [{ id: 'aa' }] }),
    ]);
    expect(issues.filter((i) => i.message.includes('cycle'))).toHaveLength(1);
  });
  it('flags duplicate ids and package names', () => {
    const issues = lintCatalog([
      lib({ id: 'aa', package_names: { npm: ['jose'] } }),
      lib({ id: 'bb', package_names: { npm: ['JOSE'] } }),
      lib({ id: 'bb' }),
    ]);
    expect(issues.map((i) => i.message).join('\n')).toMatch(/duplicate id[\s\S]*also listed/);
  });
});
