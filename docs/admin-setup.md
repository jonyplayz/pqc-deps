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

## 3. "Sign in with GitHub" (admin login)

Admins sign in with their GitHub account. Anyone with **write, maintain or
admin** access to the `pqc-deps` repo is an admin; add your co-founder as a
collaborator to give them access, remove them to take it away. This is checked
again on every admin action.

**A. Create a GitHub OAuth app**: GitHub → Settings → Developer settings →
**OAuth Apps** → **New OAuth App**
(https://github.com/settings/applications/new):

- Application name: `PQC Deps admin`
- Homepage URL: `https://pqc-deps.pages.dev`
- Authorization callback URL: `https://pqc-deps.pages.dev/api/auth/callback`
- Leave "Enable Device Flow" off, then **Register application**.
- On the next page, copy the **Client ID**, click **Generate a new client
  secret** and copy the secret.

**B. Cloudflare variables**:

| Name                         | Value                                                                                              | Type       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| `GITHUB_OAUTH_CLIENT_ID`     | the Client ID                                                                                      | text       |
| `GITHUB_OAUTH_CLIENT_SECRET` | the client secret                                                                                  | **secret** |
| `SESSION_SECRET`             | optional: own key for session cookies (32+ chars); by default it is derived from the client secret | **secret** |
| `ADMIN_GITHUB_USERS`         | optional: extra admin logins, comma separated                                                      | text       |

The site requests **no GitHub permissions** from admins (only who they are),
doesn't store their GitHub token, and keeps them signed in for 12 hours with a
signed, HttpOnly cookie. Sign-in only works on `pqc-deps.pages.dev`, the
callback URL registered above; on preview URLs admin features stay off.

## 4. Check it works

1. Open `https://pqc-deps.pages.dev/admin` and click **Sign in with GitHub**.
   After approving, you see the requests queue, Refresh, Add library and activity.
2. Open any library page while signed in: it shows **Refresh now**.
3. In a private window, open a library page: it shows **Request a re-check** with
   the Turnstile check. Submitting creates an issue labelled `public-request`
   that appears in the admin queue.

## 5. Phone notifications with Telegram (optional, free)

Admins get a Telegram message, with a button, whenever something waits for
them:

- a visitor requests a re-check or a new library (sent by the site);
- an evidence refresh or add-library run opens a PR for review;
- one of those runs fails.

1. In Telegram, message **@BotFather**, send `/newbot` and follow the steps.
   It replies with a bot token (`123456:ABC…`). Keep it secret.
2. Open a chat with your new bot and press **Start** (a bot can't message you
   until you do). For a shared admin group, add the bot to the group instead.
3. Find your chat id: message **@userinfobot**; it replies with your numeric id.
   (A group's id starts with `-`.)
4. Add both values in two places:
   - Cloudflare Pages → project → Settings → Variables and secrets (Production):
     secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
   - GitHub repo → Settings → Secrets and variables → Actions: the same two secrets.
5. Redeploy (or push any commit) so the site picks up the new secrets.

Without these secrets nothing is sent and everything else works as before. A
failed message never fails a request or a workflow.

## Local development

```bash
cp site/.dev.vars.example site/.dev.vars   # Turnstile test keys included
npm run dev:functions                       # http://localhost:8788
```

Add a `GITHUB_TOKEN` to `site/.dev.vars` to test GitHub calls. To test sign-in
locally, create a second OAuth app whose callback URL is
`http://localhost:8788/api/auth/callback` and put its ID and secret there.
