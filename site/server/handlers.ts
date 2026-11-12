/**
 * Request handlers for the Pages Functions. Each takes the request, env and a
 * GitHub client, so they can be tested without Cloudflare.
 */
import type { Env } from './env';
import { GitHub, labelNames } from './github';
import { clientIp, HttpError, json, readJsonBody } from './http';
import {
  catalogIds,
  cleanText,
  enforceDailyCap,
  isLibraryId,
  LABELS,
  libraryFields,
  libraryIssueBody,
  recheckId,
  recheckTitle,
  requestKind,
} from './requests';
import { adminUrl, notifyAdmins } from './notify';
import { verifyTurnstile } from './turnstile';

export interface Ctx {
  request: Request;
  env: Env;
  gh: () => GitHub;
  fetch?: typeof fetch;
}

const actionsUrl = (env: Env, workflow: string) =>
  `https://github.com/${env.GITHUB_REPO}/actions/workflows/${workflow}`;

// ---------------------------------------------------------------- public

export function config(env: Env): Response {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null }, 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

/** A visitor asks for a library to be re-checked. */
export async function requestRecheck({ request, env, gh, fetch: f }: Ctx): Promise<Response> {
  const body = await readJsonBody(request);
  if (!isLibraryId(body.id)) throw new HttpError(400, 'Unknown library.');
  await verifyTurnstile(body.token, env, clientIp(request), f);
  if (!(await catalogIds(env, request.url)).has(body.id))
    throw new HttpError(404, 'Unknown library.');

  const client = gh();
  const open = await client.issues(LABELS.recheck);
  const existing = open.find((i) => i.title === recheckTitle(body.id as string));
  if (existing) {
    return json({
      ok: true,
      duplicate: true,
      message: 'A re-check of this library is already queued. Thanks!',
    });
  }
  await enforceDailyCap(client, env);
  const note = cleanText(body.note, 1000);
  const issue = await client.createIssue(
    recheckTitle(body.id),
    `A visitor asked for **${body.id}** to be re-checked.${note ? `\n\n> ${note.replace(/\n/g, '\n> ')}` : ''}\n\n_Submitted through the PQC Deps website. An admin approves or rejects it from /admin._`,
    [LABELS.publicRequest, LABELS.recheck],
  );
  await notifyAdmins(
    env,
    {
      text: `🔔 PQC Deps: re-check requested for ${body.id} (#${issue.number}). Waiting for your approval.`,
      button: { label: 'Open admin', url: adminUrl(request.url) },
    },
    f,
  );
  return json({ ok: true, message: 'Thanks! A maintainer will review your request.' });
}

/** A visitor asks for a new library. */
export async function requestLibrary({ request, env, gh, fetch: f }: Ctx): Promise<Response> {
  const body = await readJsonBody(request);
  const fields = libraryFields(body);
  await verifyTurnstile(body.token, env, clientIp(request), f);
  const client = gh();
  const open = await client.issues(LABELS.newLibrary);
  if (open.some((i) => (i.body ?? '').includes(fields.repo))) {
    return json({
      ok: true,
      duplicate: true,
      message: 'This library has already been requested. Thanks!',
    });
  }
  await enforceDailyCap(client, env);
  const issue = await client.createIssue(
    `[Request] ${fields.name}`,
    libraryIssueBody(fields, cleanText(body.notes, 1500)),
    [LABELS.publicRequest, LABELS.newLibrary, 'data'],
  );
  await notifyAdmins(
    env,
    {
      text: `🔔 PQC Deps: new library requested: ${fields.name} (#${issue.number}). Waiting for your approval.`,
      button: { label: 'Open admin', url: adminUrl(request.url) },
    },
    f,
  );
  return json({ ok: true, message: 'Thanks! A maintainer will review your request.' });
}

// ---------------------------------------------------------------- admin
// (Callers must run requireAdmin first; the middleware does.)

export async function adminRefresh({ request, env, gh }: Ctx): Promise<Response> {
  const body = await readJsonBody(request);
  if (!isLibraryId(body.id) || !(await catalogIds(env, request.url)).has(body.id)) {
    throw new HttpError(404, 'Unknown library.');
  }
  await gh().dispatch('refresh.yml', { libraries: body.id });
  return json({
    ok: true,
    message: `Refresh of ${body.id} started. If anything changed, a pull request will appear for review.`,
    runsUrl: actionsUrl(env, 'refresh.yml'),
  });
}

export async function adminAdd({ request, env, gh }: Ctx): Promise<Response> {
  const body = await readJsonBody(request);
  const f = libraryFields(body);
  const inputs: Record<string, string> = { name: f.name, ecosystem: f.ecosystem, repo: f.repo };
  for (const k of [
    'packages',
    'homepage',
    'description',
    'applicable',
    'delegates',
    'watch_urls',
  ] as const) {
    if (f[k]) inputs[k] = f[k];
  }
  await gh().dispatch('add-library.yml', inputs);
  return json({
    ok: true,
    message: `Adding ${f.name}. Checks and evidence run first; then a pull request appears for review.`,
    runsUrl: actionsUrl(env, 'add-library.yml'),
  });
}

export async function adminRequests({ gh }: Ctx): Promise<Response> {
  const issues = await gh().issues(LABELS.publicRequest);
  return json({
    requests: issues
      .filter((i) => !i.pull_request && !labelNames(i).includes(LABELS.approved))
      .map((i) => ({
        number: i.number,
        kind: requestKind(i),
        title: i.title,
        url: i.html_url,
        created: i.created_at,
        body: (i.body ?? '').slice(0, 2000),
      })),
  });
}

export async function adminDecide({ request, env, gh }: Ctx, number: number): Promise<Response> {
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Bad request number.');
  const body = await readJsonBody(request);
  const action = body.action;
  if (action !== 'approve' && action !== 'reject')
    throw new HttpError(400, 'Choose approve or reject.');
  const client = gh();
  const issue = await client.issue(number);
  const kind = requestKind(issue);
  if (!kind || !labelNames(issue).includes(LABELS.publicRequest)) {
    throw new HttpError(400, 'That is not a website request.');
  }

  if (action === 'reject') {
    const reason = cleanText(body.reason, 500);
    await client.comment(
      number,
      `Thanks for the request. We're not acting on it${reason ? `: ${reason}` : '.'}`,
    );
    await client.close(number, 'not_planned');
    return json({ ok: true, message: `Request #${number} closed.` });
  }

  if (kind === 'recheck') {
    const id = recheckId(issue);
    if (!id || !(await catalogIds(env, request.url)).has(id))
      throw new HttpError(400, 'Unknown library in request.');
    await client.dispatch('refresh.yml', { libraries: id });
    await client.comment(
      number,
      `Approved: a re-check of **${id}** is running. Any changes will arrive as a pull request for review.`,
    );
    await client.close(number, 'completed');
    return json({
      ok: true,
      message: `Re-check of ${id} started.`,
      runsUrl: actionsUrl(env, 'refresh.yml'),
    });
  }

  // New library: the "approved" label starts the add-library workflow.
  await client.addLabels(number, [LABELS.approved]);
  return json({
    ok: true,
    message: `Request #${number} approved; the library is being added.`,
    runsUrl: actionsUrl(env, 'add-library.yml'),
  });
}

export async function adminActivity({ gh }: Ctx): Promise<Response> {
  const client = gh();
  const [refresh, add, pulls] = await Promise.all([
    client.runs('refresh.yml', 8),
    client.runs('add-library.yml', 8),
    client.pulls(),
  ]);
  const runs = [...refresh, ...add]
    // Every labelled issue triggers add-library.yml, which skips unless the
    // label is "approved"; those skipped runs are noise here.
    .filter((r) => r.conclusion !== 'skipped')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 12)
    .map((r) => ({
      title: r.display_title,
      workflow: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      created: r.created_at,
    }));
  const proposals = pulls
    .filter((p) => /^(pipeline\/refresh-|library\/add-)/.test(p.head.ref))
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url, created: p.created_at }));
  return json({ runs, proposals });
}
