import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LibrarySchema, lintLibrary, parseLibraryYaml, type Library } from '@pqc-deps/core';
import { excerptDoc, selectEvidence } from '../src/excerpt';
import { htmlToText, htmlTitle } from '../src/fetch/html';
import { guessKind } from '../src/fetch/url';
import { githubRepo } from '../src/fetch/github';
import type { FetchedDoc } from '../src/fetch/types';
import type { LlmClient, LlmRequest } from '../src/llm/types';
import { libraryToYaml, reportMarkdown } from '../src/output';
import { extractJson, buildUserPrompt } from '../src/prompt';
import { proposalJsonSchema, type Proposal } from '../src/proposal';
import { proposeForLibrary } from '../src/run';
import { checkQuote, normalizeForMatch } from '../src/verify';
import { deriveStatus } from '../src/merge';

const TODAY = '2026-11-08';
const lib = (o: Partial<Library> = {}): Library =>
  LibrarySchema.parse({
    id: 'demo-tls',
    name: 'DemoTLS',
    ecosystem: 'c-cpp',
    repo: 'https://github.com/demo/demo-tls',
    overall_status: 'unknown',
    last_verified: '2026-01-01',
    ...o,
  });

// ---------------------------------------------------------------- helpers

describe('html', () => {
  it('extracts readable text and title', () => {
    const html = `<html><head><title>Release &amp; notes</title><style>x{}</style></head>
<body><nav>menu</nav><h1>DemoTLS 3.5</h1><p>Adds <b>ML-KEM</b>&nbsp;support.</p><ul><li>One</li><li>Two</li></ul>
<script>alert(1)</script></body></html>`;
    expect(htmlTitle(html)).toBe('Release & notes');
    const text = htmlToText(html);
    expect(text).toContain('DemoTLS 3.5');
    expect(text).toContain('Adds ML-KEM support.');
    expect(text).toContain('- One');
    expect(text).not.toMatch(/alert|menu|x\{\}/);
  });
});

describe('fetch helpers', () => {
  it('derives owner/name from repo URLs', () => {
    expect(githubRepo(lib())).toBe('demo/demo-tls');
    expect(githubRepo(lib({ repo: 'https://gitlab.com/x/y' }))).toBeUndefined();
    expect(
      githubRepo(
        lib({ repo: 'https://gitlab.com/x/y', pipeline: { watch_urls: [], github: 'a/b' } }),
      ),
    ).toBe('a/b');
  });
  it('guesses source kinds from URLs', () => {
    expect(guessKind('https://example.org/news/3.5-release-notes.html')).toBe('release-notes');
    expect(guessKind('https://lists.example.org/pipermail/dev/2026/01.html')).toBe('mailing-list');
    expect(guessKind('https://example.org/blog/pqc')).toBe('blog');
    expect(guessKind('https://example.org/docs/tls')).toBe('docs');
  });
});

describe('excerpts', () => {
  it('keeps PQC passages with context and the header lines', () => {
    const text = [
      'Release 3.5.0',
      'date',
      'intro',
      ...Array(20).fill('unrelated'),
      'Added ML-KEM-768 to the default groups.',
      ...Array(20).fill('more'),
    ].join('\n');
    const { excerpt, hits } = excerptDoc(text, 1);
    expect(hits).toBe(1);
    expect(excerpt).toMatch(/^Release 3\.5\.0/);
    expect(excerpt).toContain('Added ML-KEM-768');
    expect(excerpt).toContain('[…]');
    expect(excerpt.split('\n').filter((l) => l === 'unrelated')).toHaveLength(1);
  });
  it('drops docs without PQC mentions, prefers release notes, respects the budget', () => {
    const docs: FetchedDoc[] = [
      { url: 'https://x/i1', title: 'Issue', kind: 'issue', text: 'Please add Kyber' },
      { url: 'https://x/r1', title: 'Rel', kind: 'release-notes', text: 'Adds ML-DSA' },
      { url: 'https://x/n', title: 'Noise', kind: 'release-notes', text: 'Bug fixes only' },
    ];
    const { selected } = selectEvidence(docs);
    expect(selected.map((d) => [d.id, d.title])).toEqual([
      ['D1', 'Rel'],
      ['D2', 'Issue'],
    ]);
    expect(selectEvidence(docs, { maxCharsTotal: 15 }).dropped).toBe(1);
  });
});

describe('quote verification', () => {
  const doc = {
    id: 'D1',
    url: 'u',
    title: 't',
    kind: 'docs' as const,
    text: 'Version 3.5 adds **ML-KEM** support.\nIt’s   enabled by default — see docs.',
  };
  it('accepts exact, whitespace-, case-, quote- and markdown-insensitive matches', () => {
    expect(checkQuote('version 3.5 adds ML-KEM support.', doc).ok).toBe(true);
    expect(checkQuote("It's enabled by default - see docs", doc).ok).toBe(true);
  });
  it('tolerates line-wrap joins without a space, but nothing else', () => {
    const wrapped = {
      ...doc,
      text: 'ported from C++ to C,\n   refactored, and integrated into the providers.',
    };
    expect(checkQuote('ported from C++ to C,refactored, and integrated', wrapped).ok).toBe(true);
    expect(checkQuote('ported from C++ to Rust, refactored, and integrated', wrapped).ok).toBe(
      false,
    );
  });
  it('accepts ellipsis-joined fragments only in order', () => {
    expect(checkQuote('Version 3.5 adds … enabled by default', doc).ok).toBe(true);
    expect(checkQuote('enabled by default ... Version 3.5 adds', doc).ok).toBe(false);
  });
  it('rejects fabricated, too-short or mis-cited quotes', () => {
    expect(checkQuote('Version 3.5 adds ML-DSA support.', doc)).toEqual({
      ok: false,
      reason: 'quote not found in the document',
    });
    expect(checkQuote('ML-KEM', doc).ok).toBe(false);
    expect(checkQuote('Version 3.5 adds ML-KEM support.', undefined).ok).toBe(false);
  });
  it('normalizes consistently', () => {
    expect(normalizeForMatch('  A’B  “c”  ')).toBe('a\'b "c"');
  });
});

describe('prompt + schema', () => {
  it('extracts JSON from fenced or chatty answers', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json')).toThrow();
  });
  it('produces a closed JSON Schema for structured outputs', () => {
    const s = proposalJsonSchema() as any;
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.algorithms.properties['ml-kem'].additionalProperties).toBe(false);
  });
  it('omits pipeline config and lists documents', () => {
    const p = buildUserPrompt(lib({ pipeline: { watch_urls: ['https://secret.example'] } }), [
      {
        id: 'D1',
        url: 'https://x',
        title: 'T "q"',
        kind: 'docs',
        text: '',
        excerpt: 'ML-KEM',
        hits: 1,
      },
    ]);
    expect(p).not.toContain('secret.example');
    expect(p).toContain(`<document id="D1" kind="docs" title="T 'q'"`);
  });
});

describe('deriveStatus', () => {
  const src = [
    {
      url: 'https://x',
      title: 't',
      kind: 'docs' as const,
      quote: 'quote text here',
      retrieved: TODAY,
    },
  ];
  it('is conservative', () => {
    expect(
      deriveStatus(
        lib({
          algorithms: { 'hybrid-tls': { support: 'yes', default_enabled: true, sources: src } },
        }),
      ),
    ).toBe('ready');
    expect(deriveStatus(lib({ algorithms: { 'ml-kem': { support: 'yes', sources: src } } }))).toBe(
      'available',
    );
    expect(
      deriveStatus(lib({ algorithms: { 'ml-kem': { support: 'partial', sources: src } } })),
    ).toBe('partial');
    expect(deriveStatus(lib())).toBe('unknown');
  });
});

// ---------------------------------------------------------------- end to end with fakes

const DOCS: FetchedDoc[] = [
  {
    url: 'https://github.com/demo/demo-tls/releases/tag/v3.5.0',
    title: 'DemoTLS 3.5.0',
    kind: 'release-notes',
    date: '2026-04-01',
    text: 'Release DemoTLS 3.5.0\n\n- Added ML-KEM-512, ML-KEM-768 and ML-KEM-1024 (FIPS 203).\n- X25519MLKEM768 is now the default key share for TLS 1.3.\n- Fixed a memory leak.',
  },
  {
    url: 'https://github.com/demo/demo-tls/issues/42',
    title: 'Issue #42: ML-DSA support',
    kind: 'issue',
    date: '2026-05-01',
    text: 'Issue #42: ML-DSA support\nState: open\n\nMaintainer: we plan to ship ML-DSA in 3.7, targeted for 2027-03.',
  },
  {
    url: 'https://example.com/unrelated',
    title: 'Unrelated',
    kind: 'docs',
    text: 'Nothing about quantum here.',
  },
];

const claim = (
  o: Partial<Proposal['algorithms']['ml-kem']> = {},
): Proposal['algorithms']['ml-kem'] => ({
  support: 'unknown',
  since_version: null,
  default_enabled: null,
  experimental: null,
  notes: null,
  evidence: [],
  ...o,
});

function fakeProposal(): Proposal {
  return {
    algorithms: {
      'ml-kem': claim({
        support: 'yes',
        since_version: '3.5.0',
        evidence: [
          { doc: 'D1', quote: 'Added ML-KEM-512, ML-KEM-768 and ML-KEM-1024 (FIPS 203).' },
        ],
      }),
      'hybrid-tls': claim({
        support: 'yes',
        since_version: '3.5.0',
        default_enabled: true,
        experimental: false,
        evidence: [
          { doc: 'D1', quote: 'X25519MLKEM768 is now the default key share for TLS 1.3.' },
        ],
      }),
      // Fabricated: this sentence is not in any document.
      'slh-dsa': claim({
        support: 'yes',
        since_version: '3.6.0',
        evidence: [{ doc: 'D1', quote: 'Added SLH-DSA signatures in 3.6.0.' }],
      }),
      // Real quote, but the version is invented.
      'ml-dsa': claim({
        support: 'partial',
        since_version: '3.4.0',
        evidence: [{ doc: 'D2', quote: 'we plan to ship ML-DSA in 3.7, targeted for 2027-03' }],
      }),
      'fn-dsa': claim(),
      hqc: claim(),
    },
    roadmap: {
      target_version: '3.7',
      target_date: '2027-03',
      confidence: 'tentative',
      summary: 'ML-DSA planned for 3.7.',
      evidence: [{ doc: 'D2', quote: 'we plan to ship ML-DSA in 3.7, targeted for 2027-03.' }],
    },
    fips: {
      status: 'validated',
      certificates: ['#9999'],
      algorithms: ['ml-kem'],
      notes: null,
      evidence: [{ doc: 'D9', quote: 'FIPS 140-3 certificate #9999 covers ML-KEM' }],
    },
    overall_status: 'ready',
    upgrade_notes: 'Upgrade to 3.5.0 or later; hybrid key exchange is on by default.',
    reviewer_notes: 'ML-DSA is only planned.',
  };
}

function fakeLlm(answer: string | (() => string)): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    label: 'fake/model',
    calls,
    async completeJson(req) {
      calls.push(req);
      return typeof answer === 'function' ? answer() : answer;
    },
  };
}

describe('proposeForLibrary (end to end with fake fetch + fake LLM)', () => {
  const fetchEvidence = async () => ({ docs: DOCS, warnings: [] });

  it('keeps verified claims, drops fabricated ones, and yields a valid file', async () => {
    const llm = fakeLlm(JSON.stringify(fakeProposal()));
    const r = await proposeForLibrary(lib(), { fetchEvidence, llm, today: TODAY });
    expect(r.error).toBeUndefined();
    const l = r.library!;

    expect(l.algorithms['ml-kem']).toMatchObject({ support: 'yes', since_version: '3.5.0' });
    expect(l.algorithms['ml-kem']!.sources[0]).toMatchObject({
      url: DOCS[0]!.url,
      kind: 'release-notes',
      retrieved: TODAY,
    });
    expect(l.algorithms['hybrid-tls']).toMatchObject({ support: 'yes', default_enabled: true });
    expect(l.algorithms['slh-dsa']).toBeUndefined(); // fabricated quote → unknown
    expect(l.algorithms['ml-dsa']).toBeUndefined(); // only an open issue → unknown
    expect(l.roadmap).toMatchObject({ target_version: '3.7', target_date: '2027-03' });
    expect(l.fips).toBeUndefined(); // cites a document that doesn't exist
    expect(l.overall_status).toBe('ready');
    expect(l.last_verified).toBe(TODAY);
    // Generated from verified claims only, not the model's wording.
    expect(l.upgrade_notes).toBe(
      'ML-KEM and hybrid TLS key exchange: DemoTLS 3.5.0 or later. On by default: hybrid TLS key exchange.',
    );

    const reasons = r.dropped.map((d) => `${d.field}: ${d.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'algorithms.slh-dsa: quote not found in the document',
        'algorithms.ml-dsa: only issue or unmerged-PR evidence; nothing shows it shipped',
        'fips: cites a document id that does not exist',
      ]),
    );

    // The model only saw documents that mention PQC.
    expect(llm.calls[0]!.user).toContain('DemoTLS 3.5.0');
    expect(llm.calls[0]!.user).not.toContain('Nothing about quantum');

    // Round-trip through YAML and the real validator.
    const yaml = libraryToYaml(l);
    expect(yaml.startsWith('# yaml-language-server')).toBe(true);
    const parsed = parseLibraryYaml(yaml, 'demo-tls.yaml');
    expect(parsed.ok).toBe(true);
    expect(lintLibrary(l, TODAY).filter((i) => i.severity === 'error')).toEqual([]);
    expect(Object.keys(parseYaml(yaml))[0]).toBe('id');

    const md = reportMarkdown(r, lib());
    expect(md).toContain('Dropped (failed verification');
    expect(md).toContain('X25519MLKEM768 is now the default key share');
  });

  it('downgrades an overall status the verified data does not support', async () => {
    const p = fakeProposal();
    p.algorithms['hybrid-tls'] = claim({
      support: 'yes',
      evidence: [{ doc: 'D1', quote: 'this sentence was never written anywhere' }],
    });
    const r = await proposeForLibrary(lib(), {
      fetchEvidence,
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
    expect(r.library!.overall_status).toBe('available');
    expect(r.warnings.join()).toMatch(/contradicts the verified data/);
  });

  it('never downgrades existing sourced claims to unknown', async () => {
    const existing = lib({
      overall_status: 'available',
      algorithms: {
        'ml-kem': {
          support: 'yes',
          since_version: '3.5.0',
          sources: [
            {
              url: 'https://old',
              title: 'old',
              kind: 'docs',
              quote: 'old verified quote',
              retrieved: '2026-01-01',
            },
          ],
        },
      },
    });
    const p = fakeProposal();
    p.algorithms['ml-kem'] = claim();
    p.algorithms['hybrid-tls'] = claim();
    p.overall_status = 'unknown';
    const r = await proposeForLibrary(existing, {
      fetchEvidence,
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
    expect(r.library!.algorithms['ml-kem']!.sources[0]!.url).toBe('https://old');
    expect(r.kept.join()).toMatch(/algorithms\.ml-kem/);
    expect(r.library!.overall_status).toBe('available');
  });

  it('retries once on invalid JSON, then reports an error', async () => {
    let n = 0;
    const llm = fakeLlm(() => (n++ === 0 ? 'not json' : JSON.stringify(fakeProposal())));
    const ok = await proposeForLibrary(lib(), { fetchEvidence, llm, today: TODAY });
    expect(ok.error).toBeUndefined();
    expect(llm.calls).toHaveLength(2);

    const bad = await proposeForLibrary(lib(), {
      fetchEvidence,
      llm: fakeLlm('{"nope": true}'),
      today: TODAY,
    });
    expect(bad.error).toMatch(/didn't match the proposal schema/);
    expect(bad.library).toBeUndefined();
  });

  it('dry run fetches and filters without calling the model', async () => {
    const r = await proposeForLibrary(lib(), { fetchEvidence, today: TODAY });
    expect(r.docs).toHaveLength(2);
    expect(r.library).toBeUndefined();
    expect(reportMarkdown(r, lib())).toContain('Dry run');
  });

  it('skips the model when nothing mentions PQC', async () => {
    const llm = fakeLlm('{}');
    const r = await proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs: [DOCS[2]!], warnings: [] }),
      llm,
      today: TODAY,
    });
    expect(llm.calls).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/nothing to propose/);
  });
});

// ---------------------------------------------------------------- guards added after the first real run

describe('changelog headings, default-on and FIPS guards', () => {
  const changelog: FetchedDoc = {
    url: 'https://github.com/demo/demo-tls/blob/HEAD/CHANGES.md',
    title: 'demo/demo-tls CHANGES.md',
    kind: 'changelog',
    text: [
      '# Changelog',
      '',
      '### Changes between 3.4 and 3.5.0 [8 Apr 2026]',
      '',
      ...Array(12).fill('* Unrelated fix.'),
      '* ML-KEM as specified in FIPS 203.',
      '  Integrated into the default and FIPS providers.',
      '* The default TLS group list now starts with X25519MLKEM768.',
      '',
      '### Changes between 3.3 and 3.4 [1 Oct 2025]',
      '* Unrelated.',
    ].join('\n'),
  };

  it('keeps the section heading in excerpts', () => {
    const { excerpt } = excerptDoc(changelog.text, 1);
    expect(excerpt).toContain('### Changes between 3.4 and 3.5.0');
  });

  it('accepts a since_version stated in the heading above the quote; rejects others', async () => {
    const p = fakeProposal();
    p.algorithms['ml-kem'] = claim({
      support: 'yes',
      since_version: '3.5.0',
      default_enabled: true,
      evidence: [{ doc: 'D1', quote: 'ML-KEM as specified in FIPS 203.' }],
    });
    p.algorithms['hybrid-tls'] = claim({
      support: 'yes',
      since_version: '3.4',
      default_enabled: true,
      evidence: [
        { doc: 'D1', quote: 'The default TLS group list now starts with X25519MLKEM768.' },
      ],
    });
    p.algorithms['ml-dsa'] = claim();
    p.algorithms['slh-dsa'] = claim();
    p.roadmap = null;
    p.fips = {
      status: 'in-process',
      certificates: [],
      algorithms: ['ml-kem'],
      notes: null,
      evidence: [{ doc: 'D1', quote: 'Integrated into the default and FIPS providers.' }],
    };
    const r = await proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs: [changelog], warnings: [] }),
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
    const l = r.library!;

    expect(l.algorithms['ml-kem']!.since_version).toBe('3.5.0'); // from the heading
    // "3.4" appears in the same heading ("between 3.4 and 3.5.0"), so the check
    // can't tell them apart: that one is left to the human reviewer.
    expect(l.algorithms['hybrid-tls']!.since_version).toBe('3.4');
    expect(l.algorithms['ml-kem']!.default_enabled).toBeUndefined(); // "ML-KEM as specified…" says nothing about defaults
    expect(l.algorithms['hybrid-tls']!.default_enabled).toBe(true); // "default TLS group list"
    expect(l.fips).toBeUndefined(); // "FIPS providers" is not validation
    expect(r.dropped.map((d) => d.reason)).toEqual(
      expect.arrayContaining([
        'no quote says it is enabled by default',
        'quote does not mention FIPS 140 validation, CMVP or a certificate',
      ]),
    );
  });

  it('treats "default provider" wording as not default-on', async () => {
    const p = fakeProposal();
    p.algorithms['ml-kem'] = claim({
      support: 'yes',
      default_enabled: true,
      evidence: [
        { doc: 'D1', quote: 'ML-KEM as specified in FIPS 203.' },
        { doc: 'D1', quote: 'Integrated into the default and FIPS providers.' },
      ],
    });
    const r = await proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs: [changelog], warnings: [] }),
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
    expect(r.library!.algorithms['ml-kem']).toMatchObject({ support: 'yes' });
    expect(r.library!.algorithms['ml-kem']!.default_enabled).toBeUndefined();
  });
});

describe('reviewer rules from the first full run', () => {
  const docs: FetchedDoc[] = [
    {
      url: 'https://example.com/releases/1.0',
      title: 'Demo 1.0',
      kind: 'release-notes',
      text: 'Release 1.0\n\nX-Wing, a hybrid KEM combining ML-KEM768 with X25519, is available.\nThe FIPS module has been validated (certificate #1234).\nOur FIPS 140-3 certificate #1234 covers ML-KEM.',
    },
    {
      url: 'https://github.com/demo/demo-tls/pull/9',
      title: 'PR #9: Add ML-DSA',
      kind: 'pull-request',
      text: 'Pull request #9: Add ML-DSA\nState: merged 2026-10-01\n\nAdds ML-DSA signing to the library.',
    },
    {
      url: 'https://github.com/demo/demo-tls/issues/3',
      title: 'Issue #3: SLH-DSA works for me',
      kind: 'issue',
      text: 'Issue #3\nState: open\n\nSLH-DSA signing works fine in my tests.',
    },
  ];
  const run = (p: Proposal) =>
    proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs, warnings: [] }),
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
  const base = (): Proposal => ({
    ...fakeProposal(),
    algorithms: {
      'ml-kem': claim(),
      'ml-dsa': claim(),
      'slh-dsa': claim(),
      'hybrid-tls': claim(),
      'fn-dsa': claim(),
      hqc: claim(),
    },
    roadmap: null,
    fips: null,
    overall_status: 'unknown',
  });

  it('a hybrid KEM is not hybrid TLS', async () => {
    const p = base();
    p.algorithms['hybrid-tls'] = claim({
      support: 'yes',
      evidence: [
        { doc: 'D1', quote: 'X-Wing, a hybrid KEM combining ML-KEM768 with X25519, is available.' },
      ],
    });
    const r = await run(p);
    expect(r.library!.algorithms['hybrid-tls']).toBeUndefined();
  });

  it('merged PRs can support "partial" but not "yes"; issues support neither', async () => {
    const p = base();
    p.algorithms['ml-dsa'] = claim({
      support: 'partial',
      evidence: [{ doc: 'D2', quote: 'Adds ML-DSA signing to the library.' }],
    });
    p.algorithms['slh-dsa'] = claim({
      support: 'yes',
      evidence: [{ doc: 'D3', quote: 'SLH-DSA signing works fine in my tests.' }],
    });
    const r = await run(p);
    expect(r.library!.algorithms['ml-dsa']).toMatchObject({ support: 'partial' });
    expect(r.library!.algorithms['slh-dsa']).toBeUndefined();

    const p2 = base();
    p2.algorithms['ml-dsa'] = claim({
      support: 'yes',
      evidence: [{ doc: 'D2', quote: 'Adds ML-DSA signing to the library.' }],
    });
    expect((await run(p2)).library!.algorithms['ml-dsa']).toBeUndefined();
  });

  it('FIPS validation must be stated for the PQC algorithms', async () => {
    const p = base();
    p.fips = {
      status: 'validated',
      certificates: [],
      algorithms: ['ml-kem'],
      notes: null,
      evidence: [{ doc: 'D1', quote: 'The FIPS module has been validated (certificate #1234).' }],
    };
    expect((await run(p)).library!.fips).toBeUndefined();
    p.fips.evidence = [{ doc: 'D1', quote: 'Our FIPS 140-3 certificate #1234 covers ML-KEM.' }];
    expect((await run(p)).library!.fips).toMatchObject({ status: 'validated' });
  });
});

describe('second-run rules', () => {
  const docs: FetchedDoc[] = [
    {
      url: 'https://example.com/releases/1.86',
      title: 'Demo 1.86',
      kind: 'release-notes',
      text: 'Release 1.86\n\nThis is mostly a hardening release closing side-channel leaks across classical and post-quantum algorithms.\nML-DSA is now the default implementation behind SIG_ml_dsa_65.',
    },
  ];
  const run = (p: Proposal) =>
    proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs, warnings: [] }),
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
  const base = (): Proposal => ({
    ...fakeProposal(),
    algorithms: {
      'ml-kem': claim(),
      'ml-dsa': claim(),
      'slh-dsa': claim(),
      'hybrid-tls': claim(),
      'fn-dsa': claim(),
      hqc: claim(),
    },
    roadmap: null,
    fips: null,
    overall_status: 'unknown',
  });

  it('a claim needs a quote that names the algorithm', async () => {
    const p = base();
    p.algorithms['ml-kem'] = claim({
      support: 'yes',
      since_version: '1.86',
      evidence: [
        {
          doc: 'D1',
          quote:
            'This is mostly a hardening release closing side-channel leaks across classical and post-quantum algorithms.',
        },
      ],
    });
    const r = await run(p);
    expect(r.library!.algorithms['ml-kem']).toBeUndefined();
    expect(r.dropped.map((d) => d.reason)).toContain('no quote names ml-kem');
  });

  it('"default implementation" is not "on by default"', async () => {
    const p = base();
    p.algorithms['ml-dsa'] = claim({
      support: 'yes',
      default_enabled: true,
      evidence: [
        { doc: 'D1', quote: 'ML-DSA is now the default implementation behind SIG_ml_dsa_65.' },
      ],
    });
    const r = await run(p);
    expect(r.library!.algorithms['ml-dsa']).toMatchObject({ support: 'yes' });
    expect(r.library!.algorithms['ml-dsa']!.default_enabled).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('retries transient errors only', async () => {
    const { withRetry, HttpError } = await import('../src/fetch/http');
    let n = 0;
    const flaky = () =>
      n++ < 2 ? Promise.reject(new HttpError('busy', 503)) : Promise.resolve('ok');
    await expect(withRetry(flaky, [1, 1])).resolves.toBe('ok');
    let m = 0;
    const notFound = () => {
      m++;
      return Promise.reject(new HttpError('nope', 404));
    };
    await expect(withRetry(notFound, [1, 1])).rejects.toThrow('nope');
    expect(m).toBe(1);
  });
});

describe('third-run fixes', () => {
  it('ignores markdown backticks the model leaves out', () => {
    const doc = {
      id: 'D1',
      url: 'u',
      title: 't',
      kind: 'release-notes' as const,
      text: 'Add `prefer-post-quantum` to default features of the `aws-lc-rs` provider.',
    };
    expect(
      checkQuote('Add prefer-post-quantum to default features of the aws-lc-rs provider.', doc).ok,
    ).toBe(true);
  });

  it('keeps model notes out of the published data', async () => {
    const r = await proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs: DOCS, warnings: [] }),
      llm: fakeLlm(
        JSON.stringify({
          ...fakeProposal(),
          algorithms: {
            ...fakeProposal().algorithms,
            'ml-kem': { ...fakeProposal().algorithms['ml-kem'], notes: 'ML-KEM-1004 is supported' },
          },
        }),
      ),
      today: TODAY,
    });
    expect(r.library!.algorithms['ml-kem']!.notes).toBeUndefined();
    expect(r.reviewerNotes).toContain('ml-kem (model note, unverified): ML-KEM-1004 is supported');
  });
});

describe('final-review rule', () => {
  it('a "yes" whose every quote says experimental becomes partial + experimental', async () => {
    const docs: FetchedDoc[] = [
      {
        url: 'https://example.com/NEWS',
        title: 'NEWS',
        kind: 'release-notes',
        text: '* Version 3.8.8\n** Experimental support for X25519MLKEM768 key exchange in TLS 1.3\n** Support for ML-KEM-1024 key encapsulation',
      },
    ];
    const p: Proposal = {
      ...fakeProposal(),
      algorithms: {
        'ml-kem': claim({
          support: 'yes',
          evidence: [
            { doc: 'D1', quote: 'Experimental support for X25519MLKEM768 key exchange in TLS 1.3' },
            { doc: 'D1', quote: 'Support for ML-KEM-1024 key encapsulation' },
          ],
        }),
        'ml-dsa': claim(),
        'slh-dsa': claim(),
        'hybrid-tls': claim({
          support: 'yes',
          evidence: [
            { doc: 'D1', quote: 'Experimental support for X25519MLKEM768 key exchange in TLS 1.3' },
          ],
        }),
        'fn-dsa': claim(),
        hqc: claim(),
      },
      roadmap: null,
      fips: null,
      overall_status: 'available',
    };
    const r = await proposeForLibrary(lib(), {
      fetchEvidence: async () => ({ docs, warnings: [] }),
      llm: fakeLlm(JSON.stringify(p)),
      today: TODAY,
    });
    expect(r.library!.algorithms['hybrid-tls']).toMatchObject({
      support: 'partial',
      experimental: true,
    });
    expect(r.library!.algorithms['ml-kem']).toMatchObject({ support: 'yes' }); // one quote isn't experimental
  });
});

describe('since-version from stable evidence', () => {
  it('ignores the version of an experimental precursor when stable evidence exists', async () => {
    const docs: FetchedDoc[] = [
      {
        url: 'https://example.com/news',
        title: 'Release Notes',
        kind: 'release-notes',
        text: [
          'Version 3.7.0, 2025-02-04',
          '- In TLS enable the hybrid x25519/ML-KEM-768 post quantum secure key exchange by default.',
          'Version 3.2.0, 2023-10-09',
          '- Add support for (experimental!) post-quantum secure key exchange in TLS 1.3',
        ].join('\n'),
      },
    ];
    const ev = [
      {
        doc: 'D1',
        quote: 'Add support for (experimental!) post-quantum secure key exchange in TLS 1.3',
      },
      {
        doc: 'D1',
        quote:
          'In TLS enable the hybrid x25519/ML-KEM-768 post quantum secure key exchange by default.',
      },
    ];
    const run = (since: string) =>
      proposeForLibrary(lib(), {
        fetchEvidence: async () => ({ docs, warnings: [] }),
        llm: fakeLlm(
          JSON.stringify({
            ...fakeProposal(),
            algorithms: {
              ...fakeProposal().algorithms,
              'ml-kem': claim(),
              'ml-dsa': claim(),
              'slh-dsa': claim(),
              'hybrid-tls': claim({
                support: 'yes',
                since_version: since,
                default_enabled: true,
                evidence: ev,
              }),
            },
            roadmap: null,
            fips: null,
          }),
        ),
        today: TODAY,
      });
    expect((await run('3.2.0')).library!.algorithms['hybrid-tls']!.since_version).toBeUndefined();
    expect((await run('3.7.0')).library!.algorithms['hybrid-tls']).toMatchObject({
      since_version: '3.7.0',
      default_enabled: true,
    });
  });
});
