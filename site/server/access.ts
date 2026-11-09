/**
 * Verify the Cloudflare Access login token (JWT) on admin requests. Access
 * already blocks unauthenticated visitors at the edge; this check makes the
 * code safe on its own too (e.g. on preview URLs Access doesn't cover).
 * Fails closed if Access isn't configured.
 */
import { HttpError } from './http';
import type { Env } from './env';

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let jwksCache: { at: number; domain: string; keys: Jwk[] } | undefined;

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function keys(domain: string, fetchImpl: typeof fetch): Promise<Jwk[]> {
  if (jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.at < 3_600_000) {
    return jwksCache.keys;
  }
  const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, 'Could not load Access signing keys.');
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), domain, keys: body.keys };
  return body.keys;
}

export function resetAccessKeyCache() {
  jwksCache = undefined;
}

function tokenFrom(request: Request): string | undefined {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = request.headers.get('Cookie') ?? '';
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1];
}

/** Returns the admin's email, or throws 401/403. */
export async function requireAdmin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, 'Admin login is not configured.');
  }
  const token = tokenFrom(request);
  if (!token) throw new HttpError(401, 'Not logged in.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid login token.');
  const [h, p, s] = parts as [string, string, string];

  let header: { alg: string; kid: string };
  let payload: { aud: string | string[]; exp: number; nbf?: number; iss: string; email?: string };
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    throw new HttpError(401, 'Invalid login token.');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Invalid login token.');

  const jwk = (await keys(env.ACCESS_TEAM_DOMAIN, fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Unknown signing key.');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new HttpError(401, 'Invalid login token.');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const nowSec = Math.floor(now / 1000);
  if (!aud.includes(env.ACCESS_AUD)) throw new HttpError(403, 'Token is for another application.');
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`)
    throw new HttpError(403, 'Wrong issuer.');
  if (payload.exp <= nowSec || (payload.nbf && payload.nbf > nowSec + 60)) {
    throw new HttpError(401, 'Login expired. Reload the page.');
  }
  const email = (payload.email ?? '').toLowerCase();
  const allow = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !allow.includes(email)) throw new HttpError(403, 'Not an admin.');
  return email;
}
