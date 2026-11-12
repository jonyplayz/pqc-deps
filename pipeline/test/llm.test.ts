import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDailyQuotaError, openAiCompatibleClient } from '../src/llm/openai-compatible';
import { bumpLastVerified, daysSince, sliceOf } from '../src/stale-util';
import { isoNow, LibrarySchema, lintLibrary } from '@pqc-deps/core';

const req = { system: 's', user: 'u', schema: { type: 'object' } };
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const quota = (per: 'Day' | 'Minute') =>
  new Response(
    JSON.stringify([
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { violations: [{ quotaId: `GenerateRequestsPer${per}PerProjectPerModel-FreeTier` }] },
          ],
        },
      },
    ]),
    { status: 429 },
  );

/** Fake fetch: answers per model name in the request body. */
function stubFetch(byModel: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model as string;
      calls.push(model);
      const next = byModel[model]!.shift();
      if (!next) throw new Error(`unexpected call to ${model}`);
      return next();
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('openAiCompatibleClient model fallback', () => {
  const client = (model: string) =>
    openAiCompatibleClient({ baseUrl: 'https://llm.example/v1', model, retryDelaysMs: [1, 1] });

  it('recognizes daily-quota 429s', () => {
    expect(
      isDailyQuotaError({ status: 429, message: 'GenerateRequestsPerDayPerProjectPerModel' }),
    ).toBe(true);
    expect(
      isDailyQuotaError({ status: 429, message: 'GenerateRequestsPerMinutePerProjectPerModel' }),
    ).toBe(false);
    expect(isDailyQuotaError({ status: 500, message: 'PerDay' })).toBe(false);
  });

  it('switches to the next model at once when the daily quota is gone, and stays there', async () => {
    const calls = stubFetch({
      best: [() => quota('Day')],
      lite: [() => ok('{"a":1}'), () => ok('{"a":2}')],
    });
    const llm = client('best, lite');
    expect(llm.label).toBe('llm.example/best');
    expect(await llm.completeJson(req)).toBe('{"a":1}');
    expect(llm.label).toBe('llm.example/lite');
    expect(await llm.completeJson(req)).toBe('{"a":2}');
    expect(calls).toEqual(['best', 'lite', 'lite']);
  });

  it('retries per-minute 429s on the same model before giving up on it', async () => {
    const calls = stubFetch({
      best: [() => quota('Minute'), () => ok('{"a":1}')],
      lite: [],
    });
    expect(await client('best,lite').completeJson(req)).toBe('{"a":1}');
    expect(calls).toEqual(['best', 'best']);
  });

  it('throws when the last model is out of quota too', async () => {
    stubFetch({ best: [() => quota('Day')], lite: [() => quota('Day')] });
    await expect(client('best,lite').completeJson(req)).rejects.toMatchObject({ status: 429 });
  });

  it('a single model behaves as before', async () => {
    const calls = stubFetch({ only: [() => ok('{"x":true}')] });
    expect(await client('only').completeJson(req)).toBe('{"x":true}');
    expect(calls).toEqual(['only']);
  });
});

describe('sliceOf', () => {
  it('splits a list into n disjoint daily slices that cover everything', () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const slices = Array.from({ length: 7 }, (_, k) => sliceOf(items, { k, n: 7 }));
    expect(slices.map((s) => s.length)).toEqual([6, 6, 6, 6, 6, 5, 5]);
    expect(slices.flat().sort((a, b) => a - b)).toEqual(items);
    expect(sliceOf(items)).toBe(items);
  });
});

describe('last_verified timestamps', () => {
  it('bumps only the top-level last_verified line', () => {
    const y =
      'id: x\nalgorithms:\n  ml-kem:\n    sources:\n      - retrieved: 2026-01-01\nlast_verified: 2026-01-02\npipeline: {}\n';
    expect(bumpLastVerified(y, '2026-11-12T13:34:47Z')).toBe(
      y.replace('last_verified: 2026-01-02', 'last_verified: 2026-11-12T13:34:47Z'),
    );
  });

  it('counts days from a date or a timestamp', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    expect(daysSince('2026-11-10', now)).toBe(2);
    expect(daysSince('2026-11-11T13:00:00Z', now)).toBe(0);
  });

  it('isoNow is a UTC timestamp to the second', () => {
    expect(isoNow(new Date('2026-11-12T13:34:47.123Z'))).toBe('2026-11-12T13:34:47Z');
  });

  it('the schema accepts a date or a UTC timestamp, and lint compares by day', () => {
    const lib = (last_verified: string) =>
      LibrarySchema.parse({
        id: 'demo',
        name: 'x',
        ecosystem: 'c-cpp',
        overall_status: 'unknown',
        last_verified,
      });
    expect(lib('2026-11-12T13:34:47Z').last_verified).toBe('2026-11-12T13:34:47Z');
    expect(() => lib('2026-11-12 13:34')).toThrow();
    expect(lintLibrary(lib('2026-11-12T23:59:59Z'), '2026-11-12').map((i) => i.path)).not.toContain(
      'last_verified',
    );
    expect(lintLibrary(lib('2026-11-13T00:00:00Z'), '2026-11-12').map((i) => i.path)).toContain(
      'last_verified',
    );
  });
});
