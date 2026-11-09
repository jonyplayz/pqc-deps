/**
 * Signed session cookies for admins. The cookie holds the GitHub login and an
 * expiry, signed with HMAC-SHA256 (SESSION_SECRET). It is HttpOnly, Secure and
 * SameSite=Lax, so page scripts can't read it and other sites can't use it.
 */
import { HttpError } from './http';

export const SESSION_COOKIE = 'pqc_admin';
export const STATE_COOKIE = 'pqc_oauth_state';
export const SESSION_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'Admin login is not configured.');
  }
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface Session {
  login: string;
  exp: number;
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Returns the session if the token is authentic and not expired. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<Session | undefined> {
  if (!token) return undefined;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return undefined;
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64url(sig),
      enc.encode(payload),
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return undefined;
  }
  if (!ok) return undefined;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (typeof s.login !== 'string' || typeof s.exp !== 'number') return undefined;
    return s.exp * 1000 > now ? s : undefined;
  } catch {
    return undefined;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get('Cookie') ?? '';
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Only same-site relative paths, to avoid open redirects after login. */
export function safeReturnPath(v: string | null | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/admin';
  return v.slice(0, 200);
}
