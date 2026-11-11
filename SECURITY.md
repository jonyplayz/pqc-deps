# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems in this project
(the website, its API, the evidence pipeline or the GitHub workflows).

Report them privately through GitHub:
**Security → Advisories → Report a vulnerability**
(https://github.com/jonyplayz/pqc-deps/security/advisories/new).

Include what you found, how to reproduce it, and its impact. We aim to reply
within a week and will credit you in the fix unless you'd rather stay anonymous.

## Scope

In scope: https://pqc-deps.pages.dev and the code in this repository, for
example authentication on `/admin`, the request forms and their abuse
protection, the workflows and how they handle untrusted input.

Out of scope: vulnerabilities in the libraries **listed** in the catalog.
Report those to their own maintainers. If our data about a library is wrong,
open a normal correction issue instead.

## How the site is protected

- Admin actions require "Sign in with GitHub" and write access to this
  repository, checked on every request.
- Visitor requests require a Cloudflare Turnstile check, are deduplicated and
  capped per day, and only accept same-origin JSON.
- Pages use a hash-based Content Security Policy, HSTS and anti-framing headers.
- The evidence pipeline never commits to `main`: every change is a pull request
  reviewed by a person.
