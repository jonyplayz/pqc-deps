# Admin and request features: one-time setup

The website's "Refresh now", "Add library", "Request a re-check" and
"Request a library" features run as Cloudflare Pages Functions. They need four
things that only the repository owner can create. Until each one exists, the
related feature is switched off (it fails closed with a clear message) and the
rest of the site works normally.

All settings below go in **Cloudflare dashboard → Workers & Pages → pqc-deps →
Settings → Variables and Secrets → Production**. Use **Encrypt** (secret) for the
ones marked secret. A new setting takes effect on the next deployment (merge to
`main`, or Actions → CI → Run workflow).

## 1. GitHub token (lets the site start workflows and open issues)

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token.

- Resource owner: your account. Repository access: **Only select repositories →
  pqc-deps**.
- Repository permissions: **Actions: Read and write**, **Issues: Read and write**,
  **Pull requests: Read-only**, **Contents: Read-only** (Metadata is added
  automatically).
- Expiration: up to a year; set a calendar reminder to rotate it.

Cloudflare variables:

| Name           | Value                | Type       |
| -------------- | -------------------- | ---------- |
| `GITHUB_REPO`  | `jonyplayz/pqc-deps` | text       |
| `GITHUB_TOKEN` | the token            | **secret** |

## 2. Turnstile (bot check on public forms)

Cloudflare dashboard → **Turnstile** → Add widget.

- Hostnames: `pqc-deps.pages.dev` (and your own domain later).
- Widget mode: **Managed**.

| Name                 | Value                                    | Type       |
| -------------------- | ---------------------------------------- | ---------- |
| `TURNSTILE_SITE_KEY` | site key                                 | text       |
| `TURNSTILE_SECRET`   | secret key                               | **secret** |
| `PUBLIC_DAILY_CAP`   | optional, default `30` requests per 24 h | text       |

## 3. Cloudflare Access (admin login)

Cloudflare dashboard → **Zero Trust** (free plan, up to 50 users). The first
time, choose a team name; your team domain becomes
`<team>.cloudflareaccess.com`.

Access → Applications → **Add an application → Self-hosted**:

- Application name: `PQC Deps admin`.
- Destinations (add both):
  - Domain `pqc-deps.pages.dev`, path `admin`
  - Domain `pqc-deps.pages.dev`, path `api/admin/*`
- Policy: **Allow**, Include → **Emails** → your email and your co-founder's.
- Login method: **One-time PIN** (email code) is enough; GitHub login is optional.

After saving, open the application and copy its **Application Audience (AUD)
Tag**.

| Name                 | Value                                      | Type |
| -------------------- | ------------------------------------------ | ---- |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`              | text |
| `ACCESS_AUD`         | the AUD tag                                | text |
| `ADMIN_EMAILS`       | optional extra allow-list, comma separated | text |

The site checks the Access login token itself too, so admin features stay off
anywhere Access isn't in front (for example on preview URLs).

## 4. Check it works

1. Open `https://pqc-deps.pages.dev/admin`: Access asks for your email and sends a
   code; then you see the requests queue, Refresh, Add library and activity.
2. Open any library page while logged in: it shows **Refresh now**.
3. In a private window, open a library page: it shows **Request a re-check** with
   the Turnstile check. Submitting creates an issue labelled `public-request`
   that appears in the admin queue.

## Local development

```bash
cp site/.dev.vars.example site/.dev.vars   # Turnstile test keys included
npm run dev:functions                       # http://localhost:8788
```

Admin login can't run locally (Access only exists on the real site); add a
`GITHUB_TOKEN` to `site/.dev.vars` to test GitHub calls.
