export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/** Turn thrown errors into JSON responses without leaking internals. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong. Please try again later.' }, 500);
  }
}

/**
 * Basic CSRF/abuse guard for state-changing requests: JSON only, and from this
 * site's own origin (browsers always send Origin on cross-site POSTs).
 */
export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;
  if (origin && origin !== self) throw new HttpError(403, 'Cross-site requests are not allowed.');
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
    throw new HttpError(415, 'Send JSON.');
  }
  const text = await request.text();
  if (text.length > 20_000) throw new HttpError(413, 'Request too large.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export function clientIp(request: Request): string | undefined {
  return request.headers.get('CF-Connecting-IP') ?? undefined;
}
