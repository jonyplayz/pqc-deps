// Telegram bot webhook: admin approvals from the phone (see server/telegram.ts).
import type { Env } from '../../../server/env';
import { GitHub } from '../../../server/github';
import { handle } from '../../../server/http';
import { handleTelegramWebhook } from '../../../server/telegram';

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(() => handleTelegramWebhook(request, env, () => GitHub.fromEnv(env)));
