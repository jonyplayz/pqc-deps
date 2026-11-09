/**
 * Bindings and settings for the Pages Functions. Set them in the Cloudflare
 * dashboard (Pages project → Settings → Variables and secrets) or with
 * `wrangler pages secret put NAME`. For local development, put them in
 * site/.dev.vars (git-ignored).
 */
export interface Env {
  /** Static assets of the site (provided by Pages). */
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };

  /** "owner/name" of the GitHub repo. */
  GITHUB_REPO: string;
  /** Fine-grained token for that repo: Actions RW, Issues RW, Pull requests R, Contents R. */
  GITHUB_TOKEN: string;

  /** GitHub OAuth app for "Sign in with GitHub" on /admin. */
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  /** Random string (32+ characters) used to sign admin session cookies. */
  SESSION_SECRET: string;
  /** Optional: GitHub logins that are admins even without repo write access, comma separated. */
  ADMIN_GITHUB_USERS?: string;

  /** Cloudflare Turnstile keys for public request forms. */
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;

  /** Max public requests (re-checks + library requests) per 24 h. Default 30. */
  PUBLIC_DAILY_CAP?: string;
}
