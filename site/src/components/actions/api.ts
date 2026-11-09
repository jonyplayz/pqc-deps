/** Browser helpers for the site's small API. */

export interface ApiResult {
  ok?: boolean;
  message?: string;
  error?: string;
  runsUrl?: string;
  duplicate?: boolean;
}

export async function postJson(url: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as ApiResult;
    if (!res.ok) return { error: data.error ?? `Request failed (${res.status}).` };
    return data;
  } catch {
    return { error: 'Network error. Check your connection and try again.' };
  }
}

export async function getJson<T>(
  url: string,
): Promise<{ data?: T; error?: string; status: number }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', redirect: 'manual' });
    if (res.type === 'opaqueredirect') return { error: 'Not logged in.', status: 401 };
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok)
      return { error: data.error ?? `Request failed (${res.status}).`, status: res.status };
    return { data, status: res.status };
  } catch {
    return { error: 'Network error.', status: 0 };
  }
}

/**
 * Is the visitor a signed-in maintainer? Without the admin session cookie the
 * admin API answers 401, so ordinary visitors simply see the visitor buttons.
 */
export async function whoAmI(): Promise<string | undefined> {
  const r = await getJson<{ login: string }>('/api/admin/whoami');
  return r.data?.login;
}

export const ECOSYSTEM_OPTIONS: Array<[string, string]> = [
  ['c-cpp', 'C / C++'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['jvm', 'Java / JVM'],
  ['python', 'Python'],
  ['javascript', 'JavaScript / Node'],
  ['dotnet', '.NET'],
  ['platform', 'OS / platform'],
];
