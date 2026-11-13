/**
 * Telegram bot for admins: approve or reject from the phone.
 *
 * Telegram calls /api/telegram/webhook with every button press and message.
 * Only updates that carry the secret header (derived from the bot token) and
 * come from TELEGRAM_CHAT_ID are acted on; everything else is ignored.
 *
 * Buttons (callback data):  a:r:<issue> approve request   x:r:<issue> reject request
 *                           a:p:<pr>    merge PR          x:p:<pr>    close PR
 *                           a:all       approve everything pending
 * Commands: /pending (list), /approve (approve everything), /help
 */
import type { Env } from './env';
import { GitHub, isPipelinePull, labelNames, type Issue, type PullRequest } from './github';
import { HttpError } from './http';
import { decideRequest } from './handlers';
import { LABELS, requestKind } from './requests';

type Fetch = typeof fetch;

/** The secret Telegram sends in X-Telegram-Bot-Api-Secret-Token; CI registers the same value. */
export async function webhookSecret(botToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(botToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('telegram-webhook'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export async function telegramApi(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  fetchImpl?: Fetch,
): Promise<unknown> {
  const f = fetchImpl ?? fetch;
  const call = (input: string, init: RequestInit) => f(input, init);
  try {
    const res = await call(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return await res.json().catch(() => undefined);
  } catch {
    return undefined;
  }
}

const send = (env: Env, text: string, keyboard?: Button[][], f?: Fetch) =>
  telegramApi(
    env,
    'sendMessage',
    {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    },
    f,
  );

// ---------------------------------------------------------------- pending work

export interface Pending {
  requests: Issue[];
  pulls: PullRequest[];
}

export async function pendingWork(client: GitHub): Promise<Pending> {
  const [issues, pulls] = await Promise.all([client.issues(LABELS.publicRequest), client.pulls()]);
  return {
    requests: issues.filter(
      (i) =>
        !(i as { pull_request?: unknown }).pull_request && !labelNames(i).includes(LABELS.approved),
    ),
    pulls: pulls.filter(isPipelinePull),
  };
}

function describe(p: Pending): string {
  if (!p.requests.length && !p.pulls.length) return '✅ Nothing is waiting for you.';
  const lines = ['⏳ Waiting for your approval:'];
  for (const i of p.requests)
    lines.push(
      `• Request #${i.number}: ${i.title}${requestKind(i) === 'library' ? ' (new library)' : ''}`,
    );
  for (const pr of p.pulls) lines.push(`• PR #${pr.number}: ${pr.title}`);
  return lines.join('\n');
}

function pendingKeyboard(p: Pending): Button[][] {
  const rows: Button[][] = [];
  for (const i of p.requests)
    rows.push([
      { text: `✅ #${i.number}`, callback_data: `a:r:${i.number}` },
      { text: `❌ #${i.number}`, callback_data: `x:r:${i.number}` },
    ]);
  for (const pr of p.pulls)
    rows.push([
      { text: `✅ Merge PR #${pr.number}`, callback_data: `a:p:${pr.number}` },
      { text: '❌ Close', callback_data: `x:p:${pr.number}` },
      { text: 'View', url: pr.html_url },
    ]);
  if (p.requests.length + p.pulls.length > 1)
    rows.push([{ text: '✅ Approve everything', callback_data: 'a:all' }]);
  return rows;
}

// ---------------------------------------------------------------- actions

async function act(
  client: GitHub,
  env: Env,
  siteUrl: string,
  verb: 'a' | 'x',
  kind: 'r' | 'p',
  number: number,
): Promise<string> {
  if (kind === 'r') {
    const r = await decideRequest(
      client,
      env,
      siteUrl,
      number,
      verb === 'a' ? 'approve' : 'reject',
    );
    return verb === 'a'
      ? `✅ ${r.message} It will merge itself once the checks pass.`
      : `❌ ${r.message}`;
  }
  const pr = await client.pull(number);
  if (!isPipelinePull(pr)) throw new HttpError(400, `PR #${number} wasn't opened by the pipeline.`);
  if (verb === 'x') {
    await client.closePull(number);
    return `❌ PR #${number} closed.`;
  }
  const how = await client.mergeWhenReady(number);
  return how === 'merged'
    ? `✅ PR #${number} merged. The site redeploys in a minute or two.`
    : `✅ PR #${number} will merge as soon as its checks pass.`;
}

async function approveAll(client: GitHub, env: Env, siteUrl: string): Promise<string> {
  const p = await pendingWork(client);
  if (!p.requests.length && !p.pulls.length) return '✅ Nothing was waiting.';
  const out: string[] = [];
  for (const i of p.requests)
    out.push(
      await act(client, env, siteUrl, 'a', 'r', i.number).catch(
        (e) => `⚠️ #${i.number}: ${(e as Error).message}`,
      ),
    );
  for (const pr of p.pulls)
    out.push(
      await act(client, env, siteUrl, 'a', 'p', pr.number).catch(
        (e) => `⚠️ PR #${pr.number}: ${(e as Error).message}`,
      ),
    );
  return out.join('\n');
}

const HELP = `PQC Deps admin bot.
/pending – what is waiting for you, with buttons
/approve – approve every pending request and merge every pipeline PR
Buttons under each notification approve or reject that one item.`;

// ---------------------------------------------------------------- webhook

interface Update {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number; text?: string };
  };
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  gh: () => GitHub,
  fetchImpl?: Fetch,
): Promise<Response> {
  const ok = () => new Response('ok');
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
    return new Response('not configured', { status: 404 });
  const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!constantTimeEqual(given, await webhookSecret(env.TELEGRAM_BOT_TOKEN)))
    return new Response('forbidden', { status: 403 });

  const update = (await request.json().catch(() => ({}))) as Update;
  const admin = String(env.TELEGRAM_CHAT_ID);
  const siteUrl = request.url;

  const cb = update.callback_query;
  if (cb) {
    const chat = String(cb.message?.chat.id ?? '');
    // In a group chat the chat id differs from the user id; accept the configured chat.
    if (chat !== admin && String(cb.from.id) !== admin) return ok();
    let reply: string;
    try {
      const m = /^([ax]):([rp]):(\d+)$/.exec(cb.data ?? '');
      if (cb.data === 'a:all') reply = await approveAll(gh(), env, siteUrl);
      else if (m)
        reply = await act(gh(), env, siteUrl, m[1] as 'a' | 'x', m[2] as 'r' | 'p', Number(m[3]));
      else reply = 'Unknown button.';
    } catch (e) {
      reply = `⚠️ ${(e as Error).message}`;
    }
    await telegramApi(
      env,
      'answerCallbackQuery',
      { callback_query_id: cb.id, text: reply.slice(0, 190) },
      fetchImpl,
    );
    if (cb.message) {
      // Replace the buttons with the outcome so nothing is pressed twice.
      await telegramApi(
        env,
        'editMessageText',
        {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: `${cb.message.text ?? ''}\n\n${reply}`.slice(0, 4000),
          disable_web_page_preview: true,
        },
        fetchImpl,
      );
    }
    return ok();
  }

  const msg = update.message;
  if (msg && String(msg.chat.id) === admin) {
    const text = (msg.text ?? '').trim().toLowerCase();
    try {
      if (/^\/?(approve|approve all|yes|אשר|אשר הכל)\b/.test(text)) {
        await send(env, await approveAll(gh(), env, siteUrl), undefined, fetchImpl);
      } else if (/^\/?(pending|list|status)\b/.test(text) || text === '/start') {
        const p = await pendingWork(gh());
        await send(env, describe(p), pendingKeyboard(p), fetchImpl);
      } else {
        await send(env, HELP, undefined, fetchImpl);
      }
    } catch (e) {
      await send(env, `⚠️ ${(e as Error).message}`, undefined, fetchImpl);
    }
  }
  return ok();
}
