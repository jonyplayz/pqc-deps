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

  /** Cloudflare Access team domain, e.g. "pqc-deps.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application protecting /admin. */
  ACCESS_AUD: string;
  /** Optional extra allow-list of admin emails, comma separated. */
  ADMIN_EMAILS?: string;

  /** Cloudflare Turnstile keys for public request forms. */
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;

  /** Max public requests (re-checks + library requests) per 24 h. Default 30. */
  PUBLIC_DAILY_CAP?: string;
}
