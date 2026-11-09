import type { Env } from '../../../server/env';
import { json } from '../../../server/http';

export const onRequestGet: PagesFunction<Env, string, { email: string }> = ({ data }) =>
  json({ email: data.email });
