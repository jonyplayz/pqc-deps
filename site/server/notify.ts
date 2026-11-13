/**
 * Phone notifications for admins through a Telegram bot (free).
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; without them this does
 * nothing. A failed notification never fails the request that triggered it:
 * the GitHub issue is the record, the message is only a nudge.
 */
import type { Env } from './env';

export interface KeyButton {
  text: string;
  /** Pressing it sends this to the bot's webhook (see telegram.ts). */
  callback_data?: string;
  url?: string;
}

export interface Notice {
  text: string;
  /** Optional link button under the message. */
  button?: { label: string; url: string };
  /** Optional rows of buttons; replaces `button`. */
  keyboard?: KeyButton[][];
}

/** Approve / Reject buttons for a new website request. */
export const requestKeyboard = (number: number, adminLink: string): KeyButton[][] => [
  [
    { text: '✅ Approve', callback_data: `a:r:${number}` },
    { text: '❌ Reject', callback_data: `x:r:${number}` },
  ],
  [{ text: 'Open admin', url: adminLink }],
];

export function telegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

export async function notifyAdmins(
  env: Env,
  notice: Notice,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  if (!telegramConfigured(env)) return false;
  // Workers throw "Illegal invocation" if the global fetch is called as a method.
  const f = fetchImpl ?? fetch;
  const send = (input: string, init: RequestInit) => f(input, init);
  try {
    const res = await send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text (no parse_mode), so visitor-supplied names can't inject markup.
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: notice.text.slice(0, 1000),
        disable_web_page_preview: true,
        ...(notice.keyboard
          ? { reply_markup: { inline_keyboard: notice.keyboard } }
          : notice.button
            ? {
                reply_markup: {
                  inline_keyboard: [[{ text: notice.button.label, url: notice.button.url }]],
                },
              }
            : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The admin page on the same site the request came to. */
export const adminUrl = (requestUrl: string) => new URL('/admin', requestUrl).toString();
