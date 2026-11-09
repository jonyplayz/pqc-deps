/**
 * Admin login with "Sign in with GitHub" (OAuth). An admin is anyone with
 * write, maintain or admin access to the GitHub repo (checked with the site's
 * repo token), or listed in ADMIN_GITHUB_USERS. The check is repeated on every
 * admin request, so removing a collaborator revokes access immediately.
 */
import type { Env } from './env';
import { GitHub } from './github';
import { HttpError } from './http';
import {
  cookie,
  randomToken,
  readCookie,
  safeReturnPath,
  SESSION_COOKIE,
  SESSION_SECONDS,
  signSession,
  STATE_COOKIE,
  verifySession,
} from './session';

const allowList = (env: Env) =>
  (env.ADMIN_GITHUB_USERS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

function requireOAuthConfig(env: Env) {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    throw new HttpError(503, 'Admin login is not configured.');
  }
}

/**
 * The key that signs session cookies: SESSION_SECRET if set, otherwise derived
 * from the OAuth client secret (HMAC with a fixed label), so only one secret
 * has to be configured. Rotating the client secret signs everyone out.
 */
export async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!env.GITHUB_OAUTH_CLIENT_SECRET) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.GITHUB_OAUTH_CLIENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode('pqc-deps admin session v1'),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Is this GitHub user an admin of the site? */
export async function isAdmin(
  login: string,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (allowList(env).includes(login.toLowerCase())) return true;
  try {
    const r = await GitHub.fromEnv(env, fetchImpl).request<{ permission: string }>(
      'GET',
      `/repos/{repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ['admin', 'maintain', 'write'].includes(r.permission);
  } catch {
    return false;
  }
}

/** Returns the admin's GitHub login, or throws 401/403. */
export async function requireAdmin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const secret = await sessionSecret(env);
  if (!secret) throw new HttpError(503, 'Admin login is not configured.');
  const session = await verifySession(readCookie(request, SESSION_COOKIE), secret, now);
  if (!session) throw new HttpError(401, 'Not signed in.');
  if (!(await isAdmin(session.login, env, fetchImpl))) {
    throw new HttpError(403, `@${session.login} is not a maintainer of this project.`);
  }
  return session.login;
}

const callbackUrl = (request: Request) => `${new URL(request.url).origin}/api/auth/callback`;

/** GET /api/auth/login?return=/admin → GitHub's consent screen. */
export function startLogin(request: Request, env: Env): Response {
  requireOAuthConfig(env);
  const state = randomToken();
  const back = safeReturnPath(new URL(request.url).searchParams.get('return'));
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackUrl(request));
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');
  // No scope: we only need to know who the user is.
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': cookie(STATE_COOKIE, `${state}|${back}`, 600),
      'Cache-Control': 'no-store',
    },
  });
}

/** GET /api/auth/callback?code&state → session cookie → back to the admin page. */
export async function finishLogin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response> {
  requireOAuthConfig(env);
  const params = new URL(request.url).searchParams;
  const [expected, back] = (readCookie(request, STATE_COOKIE) ?? '').split('|');
  const state = params.get('state');
  const code = params.get('code');
  if (!expected || !state || state !== expected || !code) {
    throw new HttpError(400, 'Login link expired or invalid. Please try signing in again.');
  }

  const tokenRes = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request),
    }),
  });
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string })
    .access_token;
  if (!token) throw new HttpError(401, 'GitHub did not confirm the login. Please try again.');

  const userRes = await fetchImpl('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pqc-deps-site',
    },
  });
  const login = ((await userRes.json().catch(() => ({}))) as { login?: string }).login;
  if (!userRes.ok || !login) throw new HttpError(401, 'Could not read your GitHub account.');
  // The user's GitHub token is not stored anywhere; only the login goes in the session.

  if (!(await isAdmin(login, env, fetchImpl))) {
    throw new HttpError(403, `@${login} is not a maintainer of this project.`);
  }
  const session = await signSession(
    { login, exp: Math.floor(now / 1000) + SESSION_SECONDS },
    await sessionSecret(env),
  );
  const headers = new Headers({ Location: safeReturnPath(back), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, session, SESSION_SECONDS));
  headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

/** POST /api/auth/logout */
export function logout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie(SESSION_COOKIE, '', 0),
      'Cache-Control': 'no-store',
    },
  });
}
