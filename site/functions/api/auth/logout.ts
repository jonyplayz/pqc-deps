import { logout } from '../../../server/auth';
import type { Env } from '../../../server/env';
import { handle, readJsonBody } from '../../../server/http';

export const onRequestPost: PagesFunction<Env> = ({ request }) =>
  handle(async () => {
    await readJsonBody(request); // same-origin JSON only
    return logout();
  });
