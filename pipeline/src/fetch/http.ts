import { execFileSync } from 'node:child_process';

export const USER_AGENT = 'pqc-deps-evidence-pipeline (+https://github.com/jonyplayz/pqc-deps)';
const MAX_BYTES = 5_000_000;

/** GITHUB_TOKEN from the environment, else the local `gh` login, else none. */
let cachedToken: string | null | undefined;
export function githubToken(): string | undefined {
  if (cachedToken !== undefined) return cachedToken ?? undefined;
  cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!cachedToken) {
    try {
      cachedToken =
        execFileSync('gh', ['auth', 'token'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken ?? undefined;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function fetchText(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ text: string; contentType: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...init.headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`${url} is too large (${len} bytes)`);
  const text = await res.text();
  return { text: text.slice(0, MAX_BYTES), contentType: res.headers.get('content-type') ?? '' };
}

export async function githubJson<T>(path: string): Promise<T> {
  const token = githubToken();
  const { text } = await fetchText(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return JSON.parse(text) as T;
}

export async function githubRaw(path: string): Promise<string> {
  const token = githubToken();
  const { text } = await fetchText(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return text;
}
