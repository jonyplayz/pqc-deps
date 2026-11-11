import { describe, expect, it } from 'vitest';
import { checkAdmin, finishLogin, isAdmin, requireAdmin, startLogin } from '../server/auth';
import { SESSION_COOKIE, safeReturnPath, signSession, verifySession } from '../server/session';
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
    GITHUB_OAUTH_CLIENT_ID: 'client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
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

// ---------------------------------------------------------------- admin login (GitHub OAuth)

describe('session cookies', () => {
  const secret = 'test-session-secret-0123456789abcdef';
  const now = Date.UTC(2026, 10, 9);

  it('round-trips a signed session and rejects tampering or expiry', async () => {
    const t = await signSession({ login: 'jonyplayz', exp: now / 1000 + 60 }, secret);
    expect(await verifySession(t, secret, now)).toEqual({
      login: 'jonyplayz',
      exp: now / 1000 + 60,
    });
    const [payload, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ login: 'attacker', exp: now / 1000 + 60 })).toString('base64url')}.${sig}`;
    expect(await verifySession(forged, secret, now)).toBeUndefined();
    expect(await verifySession(`${payload}.${sig}x`, secret, now)).toBeUndefined();
    expect(await verifySession(t, 'another-secret-0123456789abcdefghij', now)).toBeUndefined();
    expect(await verifySession(t, secret, now + 61_000)).toBeUndefined();
    expect(await verifySession('garbage', secret, now)).toBeUndefined();
  });

  it('refuses a short or missing secret', async () => {
    await expect(signSession({ login: 'x', exp: 1 }, 'short')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('only allows same-site return paths', () => {
    expect(safeReturnPath('/libraries/openssl')).toBe('/libraries/openssl');
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '', null]) {
      expect(safeReturnPath(bad)).toBe('/admin');
    }
  });
});

describe('Sign in with GitHub', () => {
  const now = Date.UTC(2026, 10, 9);

  /** Fake github.com OAuth + API. `permission` is what the repo reports for the user. */
  function fakeGitHub(
    opts: {
      login?: string;
      permission?: string;
      tokenOk?: boolean;
      /** HTTP status for the collaborator-permission endpoint (e.g. 403 when the token can't read it). */
      permissionStatus?: number;
      repoStatus?: number;
    } = {},
  ) {
    const calls: string[] = [];
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
      if (url.pathname === '/login/oauth/access_token') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          client_id: 'client-id',
          client_secret: 'client-secret',
          code: 'the-code',
        });
        return new Response(
          JSON.stringify(
            opts.tokenOk === false
              ? { error: 'bad_verification_code' }
              : { access_token: 'user-token' },
          ),
        );
      }
      if (url.pathname === '/user')
        return new Response(JSON.stringify({ login: opts.login ?? 'jonyplayz' }));
      if (url.pathname.endsWith('/permission')) {
        if (opts.permissionStatus) return new Response('{}', { status: opts.permissionStatus });
        return new Response(JSON.stringify({ permission: opts.permission ?? 'admin' }));
      }
      if (url.pathname === '/repos/jonyplayz/pqc-deps') {
        if (opts.repoStatus) return new Response('{}', { status: opts.repoStatus });
        return new Response(JSON.stringify({ owner: { login: 'jonyplayz' } }));
      }
      return new Response('{}', { status: 404 });
    };
    return { calls, fetch: f };
  }

  const callback = (state: string, cookieState: string, code = 'the-code') =>
    new Request(`${ORIGIN}/api/auth/callback?code=${code}&state=${state}`, {
      headers: { Cookie: `pqc_oauth_state=${encodeURIComponent(cookieState)}` },
    });

  it('starts login with a state cookie and no scopes', () => {
    const res = startLogin(new Request(`${ORIGIN}/api/auth/login?return=/libraries/botan`), env());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('client-id');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    expect(loc.searchParams.get('scope')).toBeNull();
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(
      /^pqc_oauth_state=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    expect(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!)).toBe(
      `${loc.searchParams.get('state')}|/libraries/botan`,
    );
  });

  it('signs in a maintainer and returns them to the page they came from', async () => {
    const gh = fakeGitHub();
    const res = await finishLogin(callback('s1', 's1|/libraries/botan'), env(), gh.fetch, now);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/libraries/botan');
    const session = res.headers
      .get('Set-Cookie')!
      .split(', ')
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
    // The session cookie then authorizes admin requests.
    const token = decodeURIComponent(session.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
    const admin = new Request(`${ORIGIN}/api/admin/whoami`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    expect(await requireAdmin(admin, env(), gh.fetch, now)).toBe('jonyplayz');
    expect(gh.calls).toContain(
      'GET api.github.com/repos/jonyplayz/pqc-deps/collaborators/jonyplayz/permission',
    );
  });

  it('rejects a wrong or missing state (CSRF) and a failed code exchange', async () => {
    const gh = fakeGitHub();
    await expect(
      finishLogin(callback('evil', 's1|/admin'), env(), gh.fetch, now),
    ).rejects.toMatchObject({ status: 400 });
    await expect(finishLogin(callback('s1', ''), env(), gh.fetch, now)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      finishLogin(callback('s1', 's1|/admin'), env(), fakeGitHub({ tokenOk: false }).fetch, now),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses people without write access, unless allow-listed', async () => {
    const reader = fakeGitHub({ login: 'stranger', permission: 'read' });
    await expect(
      finishLogin(callback('s1', 's1|/admin'), env(), reader.fetch, now),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await isAdmin('stranger', env({ ADMIN_GITHUB_USERS: 'Stranger, other' }), reader.fetch),
    ).toBe(true);
    expect(await isAdmin('writer', env(), fakeGitHub({ permission: 'write' }).fetch)).toBe(true);
    expect(await isAdmin('nobody', env(), fakeGitHub({ permission: 'none' }).fetch)).toBe(false);
  });

  it('works without SESSION_SECRET by deriving the key from the OAuth client secret', async () => {
    const e = env({ SESSION_SECRET: undefined });
    const gh = fakeGitHub();
    const res = await finishLogin(callback('s1', 's1|/admin'), e, gh.fetch, now);
    const session = res.headers
      .get('Set-Cookie')!
      .split(', ')
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const token = decodeURIComponent(session.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
    const req = new Request(`${ORIGIN}/api/admin/whoami`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    expect(await requireAdmin(req, e, gh.fetch, now)).toBe('jonyplayz');
    // A different client secret (e.g. after rotation) invalidates the session.
    await expect(
      requireAdmin(req, { ...e, GITHUB_OAUTH_CLIENT_SECRET: 'rotated-secret' }, gh.fetch, now),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('re-checks access on every admin request, so removed maintainers lose access', async () => {
    const token = await signSession(
      { login: 'former', exp: now / 1000 + 600 },
      env().SESSION_SECRET!,
    );
    const req = new Request(`${ORIGIN}/api/admin/whoami`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    await expect(
      requireAdmin(req, env(), fakeGitHub({ permission: 'read' }).fetch, now),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed when login is not configured or there is no cookie', async () => {
    expect(() =>
      startLogin(new Request(`${ORIGIN}/api/auth/login`), env({ GITHUB_OAUTH_CLIENT_ID: '' })),
    ).toThrow(HttpError);
    await expect(
      requireAdmin(
        new Request(ORIGIN),
        env({ SESSION_SECRET: '', GITHUB_OAUTH_CLIENT_SECRET: '' }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      requireAdmin(new Request(ORIGIN), env(), fakeGitHub().fetch, now),
    ).rejects.toMatchObject({ status: 401 });
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

describe('maintainer check fallbacks (found in the live test)', () => {
  const now = Date.UTC(2026, 10, 9);
  const fake = (permissionStatus?: number, repoStatus?: number) => {
    const f: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/permission')) {
        return permissionStatus
          ? new Response('{}', { status: permissionStatus })
          : new Response(JSON.stringify({ permission: 'read' }));
      }
      if (url.pathname === '/repos/jonyplayz/pqc-deps') {
        return repoStatus
          ? new Response('{}', { status: repoStatus })
          : new Response(JSON.stringify({ owner: { login: 'jonyplayz' } }));
      }
      return new Response('{}', { status: 404 });
    };
    return f;
  };
  const sessionReq = async (login: string) => {
    const token = await signSession({ login, exp: now / 1000 + 600 }, env().SESSION_SECRET!);
    return new Request(`${ORIGIN}/api/admin/whoami`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
  };

  it('the repo owner is an admin even when the token cannot read collaborator permissions', async () => {
    expect(await requireAdmin(await sessionReq('jonyplayz'), env(), fake(403), now)).toBe(
      'jonyplayz',
    );
  });

  it('others get a configuration error (503) naming the problem, not "not a maintainer"', async () => {
    await expect(
      requireAdmin(await sessionReq('cofounder'), env(), fake(403), now),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(
        /Could not check collaborator access \(GitHub returned 403\.\)/,
      ),
    });
    await expect(
      requireAdmin(await sessionReq('cofounder'), env(), fake(401, 401), now),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/Check the site's GITHUB_TOKEN/),
    });
  });

  it('a readable "read" permission still means not a maintainer (403)', async () => {
    await expect(
      requireAdmin(await sessionReq('stranger'), env(), fake(), now),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('Workers-safe fetch (found in the live test)', () => {
  it('never calls the global fetch with the GitHub client as `this`', async () => {
    const original = globalThis.fetch;
    // Mimic Cloudflare Workers: fetch throws "Illegal invocation" unless called unbound.
    const strict = function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      return Promise.resolve(
        new Response(JSON.stringify({ owner: { login: 'jonyplayz' } }), { status: 200 }),
      );
    } as typeof fetch;
    globalThis.fetch = strict;
    try {
      // Default fetch, and the global fetch passed in explicitly (as auth.ts does via
      // default parameters). The second case is what still failed after the first fix.
      for (const gh of [
        new GitHub('jonyplayz/pqc-deps', 't'),
        new GitHub('jonyplayz/pqc-deps', 't', globalThis.fetch),
      ]) {
        await expect(gh.request('GET', '/repos/{repo}')).resolves.toEqual({
          owner: { login: 'jonyplayz' },
        });
      }
      // And end to end through the admin check, which takes fetch as a default parameter.
      const r = await checkAdmin('jonyplayz', env());
      expect(r.problem).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
