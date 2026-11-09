import { beforeEach, describe, expect, it } from 'vitest';
import { requireAdmin, resetAccessKeyCache } from '../server/access';
import type { Env } from '../server/env';
import { GitHub } from '../server/github';
import {
  adminActivity,
  adminAdd,
  adminDecide,
  adminRefresh,
  adminRequests,
  requestLibrary,
  requestRecheck,
} from '../server/handlers';
import { handle, HttpError } from '../server/http';
import { cleanText, libraryFields, libraryIssueBody } from '../server/requests';
import { normalizeInput, rawInputFromIssue } from '../../pipeline/src/add-library/input';

// ---------------------------------------------------------------- fakes

const ORIGIN = 'https://pqc-deps.pages.dev';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: async () =>
        new Response(JSON.stringify({ libraries: [{ id: 'openssl' }, { id: 'botan' }] })),
    },
    GITHUB_REPO: 'jonyplayz/pqc-deps',
    GITHUB_TOKEN: 't',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-123',
    TURNSTILE_SITE_KEY: 'site',
    TURNSTILE_SECRET: 'secret',
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body?: any;
}

/** A fake GitHub API + Turnstile endpoint driven by a small in-memory state. */
function fakeServices(state: { issues?: any[]; recent?: number; turnstile?: boolean } = {}) {
  const calls: Call[] = [];
  const issues = state.issues ?? [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'challenges.cloudflare.com') {
      return new Response(JSON.stringify({ success: state.turnstile ?? true }));
    }
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname + url.search;
    calls.push({ method, path, body });
    const respond = (data: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(data), { status });
    if (url.pathname.endsWith('/dispatches')) return respond(null, 204);
    if (url.pathname === '/search/issues') return respond({ total_count: state.recent ?? 0 });
    if (url.pathname.endsWith('/issues') && method === 'GET') {
      const label = url.searchParams.get('labels');
      return respond(issues.filter((i) => i.labels.some((l: any) => l.name === label)));
    }
    if (url.pathname.endsWith('/issues') && method === 'POST') return respond({ number: 99 }, 201);
    const one = /\/issues\/(\d+)$/.exec(url.pathname);
    if (one && method === 'GET') return respond(issues.find((i) => i.number === Number(one[1])));
    if (/\/runs/.test(url.pathname)) {
      return respond({
        workflow_runs: [
          {
            id: 1,
            name: url.pathname.includes('refresh') ? 'Evidence refresh' : 'Add library',
            display_title: url.pathname.includes('refresh')
              ? 'Evidence refresh: openssl'
              : 'Add library: Botan',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/x',
            created_at: url.pathname.includes('refresh')
              ? '2026-11-09T10:00:00Z'
              : '2026-11-09T11:00:00Z',
            event: 'workflow_dispatch',
          },
        ],
      });
    }
    if (url.pathname.endsWith('/pulls')) {
      return respond([
        {
          number: 7,
          title: 'Add Botan',
          html_url: 'u',
          created_at: 'c',
          head: { ref: 'library/add-botan-x' },
        },
        {
          number: 8,
          title: 'Dependabot',
          html_url: 'u',
          created_at: 'c',
          head: { ref: 'dependabot/npm' },
        },
      ]);
    }
    return respond({}, 200);
  };
  return { calls, fetch: f, gh: () => new GitHub('jonyplayz/pqc-deps', 't', f) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

const status = async (p: Promise<Response>) => (await handle(() => p)).status;
const bodyOf = async (p: Promise<Response>) => (await handle(() => p)).json() as Promise<any>;

// ---------------------------------------------------------------- Access JWT

describe('requireAdmin (Cloudflare Access JWT)', () => {
  let keys: CryptoKeyPair;
  let jwk: JsonWebKey;
  const b64url = (b: ArrayBuffer | Uint8Array) =>
    Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
  const sign = async (payload: object, kid = 'k1', alg = 'RS256') => {
    const h = b64url(new TextEncoder().encode(JSON.stringify({ alg, kid })));
    const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keys.privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(sig)}`;
  };
  const certs: typeof fetch = async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }));
  const now = Date.UTC(2026, 10, 9);
  const good = {
    aud: ['aud-123'],
    iss: 'https://team.cloudflareaccess.com',
    exp: now / 1000 + 600,
    email: 'Admin@Example.com',
  };
  const req = (token: string, how: 'header' | 'cookie' = 'header') =>
    new Request(`${ORIGIN}/api/admin/whoami`, {
      headers:
        how === 'header'
          ? { 'Cf-Access-Jwt-Assertion': token }
          : { Cookie: `a=b; CF_Authorization=${token}` },
    });

  beforeEach(async () => {
    resetAccessKeyCache();
    keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  });

  it('accepts a valid token from the header or the cookie', async () => {
    const t = await sign(good);
    expect(await requireAdmin(req(t), env(), certs, now)).toBe('admin@example.com');
    expect(await requireAdmin(req(t, 'cookie'), env(), certs, now)).toBe('admin@example.com');
  });

  it.each([
    ['wrong audience', { ...good, aud: ['other'] }, 403],
    ['wrong issuer', { ...good, iss: 'https://evil.cloudflareaccess.com' }, 403],
    ['expired', { ...good, exp: now / 1000 - 1 }, 401],
  ])('rejects %s', async (_n, payload, code) => {
    const t = await sign(payload);
    await expect(requireAdmin(req(t), env(), certs, now)).rejects.toMatchObject({ status: code });
  });

  it('rejects tampered, unsigned, unknown-key and missing tokens', async () => {
    const t = await sign(good);
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify({ ...good, email: 'x@evil.com' })))}.${s}`;
    await expect(requireAdmin(req(forged), env(), certs, now)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      requireAdmin(req(await sign(good, 'k1', 'none')), env(), certs, now),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      requireAdmin(req(await sign(good, 'other')), env(), certs, now),
    ).rejects.toMatchObject({ status: 401 });
    await expect(requireAdmin(new Request(ORIGIN), env(), certs, now)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('fails closed when Access is not configured, and honours the email allow-list', async () => {
    const t = await sign(good);
    await expect(requireAdmin(req(t), env({ ACCESS_AUD: '' }), certs, now)).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      requireAdmin(req(t), env({ ADMIN_EMAILS: 'someone@else.com' }), certs, now),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await requireAdmin(req(t), env({ ADMIN_EMAILS: 'admin@example.com, x@y.z' }), certs, now),
    ).toBe('admin@example.com');
  });
});

// ---------------------------------------------------------------- input guards

describe('request guards', () => {
  it('rejects cross-site and non-JSON posts', async () => {
    const s = fakeServices();
    const ctx = (request: Request) => ({ request, env: env(), gh: s.gh, fetch: s.fetch });
    expect(
      await status(
        requestRecheck(
          ctx(
            post(
              '/api/request/recheck',
              { id: 'openssl', token: 'x' },
              { Origin: 'https://evil.example' },
            ),
          ),
        ),
      ),
    ).toBe(403);
    const form = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: 'id=openssl',
    });
    expect(await status(requestRecheck(ctx(form)))).toBe(415);
  });

  it('cleans free text: no HTML, no @mentions, length limit', () => {
    expect(cleanText('<script>hi</script> @octocat', 100)).toBe('scripthi/script @​octocat');
    expect(cleanText('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('validates library fields', () => {
    const ok = {
      name: 'Botan',
      ecosystem: 'c-cpp',
      repo: 'https://github.com/randombit/botan',
      packages: 'npm:x, pypi:y',
      applicable: 'ml-kem ml-dsa',
    };
    expect(libraryFields(ok)).toMatchObject({
      packages: 'npm:x pypi:y',
      applicable: 'ml-kem ml-dsa',
    });
    for (const bad of [
      { ...ok, name: 'B' },
      { ...ok, ecosystem: 'cobol' },
      { ...ok, repo: 'http://x.org' },
      { ...ok, repo: 'javascript:alert(1)' },
      { ...ok, packages: 'jose' },
      { ...ok, applicable: 'rsa' },
      { ...ok, delegates: 'Not An Id' },
      { ...ok, watch_urls: 'http://x' },
    ]) {
      expect(() => libraryFields(bad)).toThrow(HttpError);
    }
  });

  it('builds an issue body the add-library workflow can parse', () => {
    const f = libraryFields({
      name: 'Botan',
      ecosystem: 'c-cpp',
      repo: 'https://github.com/randombit/botan',
      packages: 'npm:x pypi:y',
      applicable: 'ml-kem ml-dsa',
      watch_urls: 'https://botan.randombit.net/news.html',
    });
    const { input, errors } = normalizeInput(rawInputFromIssue(libraryIssueBody(f, 'thanks')));
    expect(errors).toEqual([]);
    expect(input).toMatchObject({
      name: 'Botan',
      ecosystem: 'c-cpp',
      package_names: { npm: ['x'], pypi: ['y'] },
      applicable_algorithms: ['ml-kem', 'ml-dsa'],
      watch_urls: ['https://botan.randombit.net/news.html'],
    });
  });
});

// ---------------------------------------------------------------- public requests

describe('public requests', () => {
  it('creates a re-check issue after Turnstile and catalog checks', async () => {
    const s = fakeServices();
    const r = await bodyOf(
      requestRecheck({
        request: post('/x', { id: 'openssl', token: 'tok', note: 'new release @someone' }),
        env: env(),
        gh: s.gh,
        fetch: s.fetch,
      }),
    );
    expect(r.ok).toBe(true);
    const created = s.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
    expect(created.body).toMatchObject({
      title: '[Re-check] openssl',
      labels: ['public-request', 'recheck-request'],
    });
    expect(created.body.body).toContain('@​someone');
  });

  it('refuses failed Turnstile, unknown libraries, duplicates and over-cap', async () => {
    const run = (s: ReturnType<typeof fakeServices>, id = 'openssl') =>
      handle(() =>
        requestRecheck({
          request: post('/x', { id, token: 'tok' }),
          env: env(),
          gh: s.gh,
          fetch: s.fetch,
        }),
      );
    expect((await run(fakeServices({ turnstile: false }))).status).toBe(403);
    expect((await run(fakeServices(), 'not-in-catalog')).status).toBe(404);
    const dup = fakeServices({
      issues: [{ number: 5, title: '[Re-check] openssl', labels: [{ name: 'recheck-request' }] }],
    });
    expect(await (await run(dup)).json()).toMatchObject({ duplicate: true });
    expect(dup.calls.some((c) => c.method === 'POST')).toBe(false);
    expect((await run(fakeServices({ recent: 30 }))).status).toBe(429);
  });

  it('creates a library request issue, deduplicated by repo', async () => {
    const s = fakeServices();
    const body = {
      name: 'Botan',
      ecosystem: 'c-cpp',
      repo: 'https://github.com/randombit/botan',
      token: 'tok',
    };
    expect(
      (
        await bodyOf(
          requestLibrary({ request: post('/x', body), env: env(), gh: s.gh, fetch: s.fetch }),
        )
      ).ok,
    ).toBe(true);
    expect(s.calls.find((c) => c.method === 'POST')!.body.labels).toEqual([
      'public-request',
      'new-library',
      'data',
    ]);
    const dup = fakeServices({
      issues: [
        {
          number: 3,
          title: 'x',
          body: 'Source https://github.com/randombit/botan',
          labels: [{ name: 'new-library' }],
        },
      ],
    });
    expect(
      await bodyOf(
        requestLibrary({ request: post('/x', body), env: env(), gh: dup.gh, fetch: dup.fetch }),
      ),
    ).toMatchObject({ duplicate: true });
  });
});

// ---------------------------------------------------------------- admin actions

describe('admin actions', () => {
  it('refresh dispatches the refresh workflow for a catalog library only', async () => {
    const s = fakeServices();
    await bodyOf(adminRefresh({ request: post('/x', { id: 'botan' }), env: env(), gh: s.gh }));
    expect(s.calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/jonyplayz/pqc-deps/actions/workflows/refresh.yml/dispatches',
      body: { ref: 'main', inputs: { libraries: 'botan' } },
    });
    expect(
      await status(adminRefresh({ request: post('/x', { id: 'zzz' }), env: env(), gh: s.gh })),
    ).toBe(404);
  });

  it('add dispatches add-library with only filled inputs', async () => {
    const s = fakeServices();
    await bodyOf(
      adminAdd({
        request: post('/x', {
          name: 'Botan',
          ecosystem: 'c-cpp',
          repo: 'https://github.com/randombit/botan',
          packages: '',
        }),
        env: env(),
        gh: s.gh,
      }),
    );
    expect(s.calls[0]!.body).toEqual({
      ref: 'main',
      inputs: { name: 'Botan', ecosystem: 'c-cpp', repo: 'https://github.com/randombit/botan' },
    });
  });

  const issues = [
    {
      number: 11,
      title: '[Re-check] openssl',
      body: '',
      html_url: 'u',
      created_at: 'c',
      labels: [{ name: 'public-request' }, { name: 'recheck-request' }],
    },
    {
      number: 12,
      title: '[Request] Botan',
      body: '',
      html_url: 'u',
      created_at: 'c',
      labels: [{ name: 'public-request' }, { name: 'new-library' }],
    },
    {
      number: 13,
      title: 'Bug',
      body: '',
      html_url: 'u',
      created_at: 'c',
      labels: [{ name: 'bug' }],
    },
  ];

  it('lists website requests', async () => {
    const s = fakeServices({ issues });
    const r = await bodyOf(adminRequests({ request: new Request(ORIGIN), env: env(), gh: s.gh }));
    expect(r.requests.map((x: any) => [x.number, x.kind])).toEqual([
      [11, 'recheck'],
      [12, 'library'],
    ]);
  });

  it('approving a re-check dispatches the refresh and closes the issue', async () => {
    const s = fakeServices({ issues });
    await bodyOf(
      adminDecide({ request: post('/x', { action: 'approve' }), env: env(), gh: s.gh }, 11),
    );
    const paths = s.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      'POST /repos/jonyplayz/pqc-deps/actions/workflows/refresh.yml/dispatches',
      'POST /repos/jonyplayz/pqc-deps/issues/11/comments',
      'PATCH /repos/jonyplayz/pqc-deps/issues/11',
    ]);
  });

  it('approving a library request adds the approved label; rejecting closes it', async () => {
    const s = fakeServices({ issues });
    await bodyOf(
      adminDecide({ request: post('/x', { action: 'approve' }), env: env(), gh: s.gh }, 12),
    );
    expect(s.calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/repos/jonyplayz/pqc-deps/issues/12/labels',
      body: { labels: ['approved'] },
    });
    const r = fakeServices({ issues });
    await bodyOf(
      adminDecide(
        { request: post('/x', { action: 'reject', reason: 'out of scope' }), env: env(), gh: r.gh },
        12,
      ),
    );
    expect(r.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      state: 'closed',
      state_reason: 'not_planned',
    });
  });

  it('refuses to act on issues that are not website requests', async () => {
    const s = fakeServices({ issues });
    expect(
      await status(
        adminDecide({ request: post('/x', { action: 'approve' }), env: env(), gh: s.gh }, 13),
      ),
    ).toBe(400);
  });

  it('activity merges runs and keeps only proposal PRs', async () => {
    const s = fakeServices();
    const r = await bodyOf(adminActivity({ request: new Request(ORIGIN), env: env(), gh: s.gh }));
    expect(r.runs.map((x: any) => x.title)).toEqual([
      'Add library: Botan',
      'Evidence refresh: openssl',
    ]);
    expect(r.proposals.map((p: any) => p.number)).toEqual([7]);
  });
});
