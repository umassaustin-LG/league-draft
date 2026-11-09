# Threat model: league-draft, JAS-Test-Devin, microsoft.github.io

_This threat model was written from the code (2026-11-08) and is used to rank security-scan findings. It is inferred: no attackers have been ruled out and no risks have been accepted yet. Edit it as those decisions are made._

## System overview

| Repository | What it is | Security relevance |
|---|---|---|
| `umassaustin-LG/league-draft` | Little League draft app. A React/Vite SPA (`src/`) plus a Django function-view API (`server/`, no DRF) on PostgreSQL. Deployed to GKE through CircleCI (`.circleci/config.yml`, image `us-east1-docker.pkg.dev/gaimplan-core/builds/league-draft:latest`). `k8s/` has an nginx ingress with TLS at `league-draft.gaimplan.com`, 2 replicas, and secrets from `league-draft-secrets`. | **Primary target.** It is multi-tenant and stores data about minors. |
| `umassaustin-LG/JAS-Test-Devin` | The default branch `main` holds only `README.md`, and the scan covers `main`. The app ("Clubhouse", formerly League Hub) is a fork of league-draft plus a `server/hub` Django app, `src/hub/`, a PWA service worker (`public/sw.js`) and Workflow OS governance files. It lives on unmerged `devin/*` branches, the latest being `devin/1794075709-league-hub-phase4`, and has a live preview on AWS Lightsail (container service `lgll-hub` plus Lightsail Postgres). | There is close to nothing to scan on `main`. The real code is out of this scan's view unless a branch-pinned scan is added. |
| `umassaustin-LG/microsoft.github.io` | Fork of Microsoft's GitHub Pages site: static HTML/Markdown, meta-refresh and JS redirect stubs (`index.html`, `presidio/`, `cadl/`, `reverse-proxy/`), the code of conduct, and the MSRC `SECURITY.MD` (a disclosure policy, not a security model). It has no server side. | Low. Realistic issues are open redirects, XSS in static pages and third-party script includes. |

Infrastructure: there is no separate infrastructure repository. The infrastructure code is `league-draft/k8s/*.yaml`, `Dockerfile` and `.circleci/config.yml`; `docker-compose.yml` is for local development only. The JAS-Test-Devin Lightsail deployment has no infrastructure code in any repository.

## Trust boundaries

1. **Internet → nginx ingress → Django (gunicorn :8000).** `/api`, `/health` and `/` all route to the Django service. TLS is terminated at the ingress (cert-manager, ssl-redirect).
2. **Browser SPA → API.** Uses session cookies (`credentials: 'include'` in `src/api/client.ts`), CSRF via a readable `csrftoken` cookie, and CORS restricted by `CORS_ALLOWED_ORIGINS` with `CORS_ALLOW_CREDENTIALS = True`.
3. **Tenant boundary (Organization/League).** `server/draft/middleware.py` `TenantMiddleware` picks `request.organization` from the `X-Organization-ID` or `X-League-ID` header, but only if the user has a membership there. A `master_admin` can pick any organization. Views must scope every query to `request.organization` (`TenantQuerySet`/`TenantManager` in `models.py`, `_verify_division_access` in `views/draft.py`).
4. **Role boundary within a tenant.** `OrganizationMembership.role` is admin, coach or viewer. Checks use `require_org_admin` (`views/helpers.py`), `_require_admin` (`views/leagues.py`) and `_require_league_admin` (`views/draft.py`). The global `User.role` is `master_admin` or `user`.
5. **API → PostgreSQL.** `DATABASE_URL` comes from a k8s secret.
6. **CI/CD → GCP.** CircleCI holds the GCP service-account key (`_json_key`) that pushes images and deploys.

## Components

| Component | Covers |
|---|---|
| `Web client` | `league-draft/src/**`, `index.html`, `vite.config.ts` (the SPA, CSV/Excel import parsing, exports, localStorage mode) |
| `Auth` | `server/draft/views/auth.py`, `throttling.py`, `validators.py`, `input_validators.py`, `middleware.py`, `views/helpers.py` (`require_auth`, `require_org_admin`), and the auth/session/CSRF settings in `league_draft/settings.py` |
| `Leagues & membership` | `server/draft/views/leagues.py` (members, roles, invitations, join links, public join-link lookup) |
| `Draft API` | `server/draft/views/{divisions,teams,players,draft,team_builder,evaluation_templates,seasons,coach_ratings}.py`, `services*.py`, `transformers.py`, `models.py`, `management/` |
| `Infrastructure` | `league-draft/k8s/**`, `Dockerfile`, `.circleci/config.yml`, `docker-compose.yml`, `server/.env.example` |
| `Static site` | everything in `umassaustin-LG/microsoft.github.io` |
| `JAS-Test-Devin` | everything in `umassaustin-LG/JAS-Test-Devin` (`main`) |

## Entry points and who can reach them

- **Anonymous:** `GET /health`, `GET /api/auth/csrf/`, `POST /api/auth/register/` (can create a user and a league), `POST /api/auth/login/`, `POST /api/auth/password-reset/` and `/confirm/`, and `GET /api/leagues/join/{token}/` (returns the league name, the inviter's email and the role for an invitation token; rate-limited by `anon_rate_limiter`). The static site is fully public.
- **Any authenticated user:** `/api/auth/me/`, change password, accept an invitation, join via link.
- **League members (viewer/coach):** read divisions, teams, players and draft state. Most data views are decorated only with `@require_auth` + `@csrf_protect`, so the role and tenant checks inside each view are what keeps data separated.
- **League admins:** member/role management, invitations, join links, division/player/team CRUD, bulk player import, draft start/pick/undo/skip/trade, team builder, coach ratings.
- **master_admin:** cross-tenant access to any organization through a header.

## Assets and sensitivity

1. **Children's personal data** (`Player`: first/last name, `birthday`, `little_league_age`, sibling links, coach-kid flags) and **evaluation scores, ranks and coach ratings**. These are minors' records, so this is the most sensitive asset (inferred).
2. **Tenant isolation.** One league must never read or modify another league's data.
3. **Draft integrity.** Picks, undo, skip, trades and mandatory coach-kid/sibling rules decide real team rosters.
4. **Accounts:** emails, password hashes, sessions, password-reset and invitation/join tokens, and the `master_admin` role.
5. **Deployment secrets:** `SECRET_KEY`, `DATABASE_URL`, the GCP deploy key in CircleCI.

## Attacker profiles (inferred; none ruled out yet)

- **Anonymous internet attacker:** credential stuffing, registration abuse, token guessing or enumeration, password-reset abuse, CSRF/CORS abuse against logged-in admins.
- **Low-privilege member of the same league (viewer/coach):** escalating to admin, or changing picks, trades, scores or rosters. Coaches have a real incentive to tamper with the draft.
- **Member of another league:** IDOR / cross-tenant reads or writes through UUIDs or the `X-Organization-ID`/`X-League-ID` headers.
- **Malicious league admin:** abusing invitations, roles or imports (CSV/Excel formula injection into exports, stored XSS) against other users.
- **Supply chain / CI:** npm and pip dependencies, the CircleCI GCP key, the `:latest` image tag.

## Existing controls

- Session auth with `SESSION_COOKIE_HTTPONLY`, `SameSite=Lax`, 24h `SESSION_COOKIE_AGE`. CSRF with `@csrf_protect` on views. `CSRF_TRUSTED_ORIGINS`.
- Rate limits: login/register 5/min, password reset 3/hr (`throttling.py`). These use a locmem cache, so they apply per process and per replica.
- `StrongPasswordValidator` and Django validators. Email is read-only on the profile.
- Tenant middleware checks membership before honoring the org header. `TenantManager` scoping.
- Production: `DEBUG=False`, `SECRET_KEY` and `DATABASE_URL` from k8s secrets, non-root container user, TLS at the ingress, ALLOWED_HOSTS/CORS pinned to `league-draft.gaimplan.com`.

## Known weak spots to watch (observations, not user-confirmed)

- `settings.py` falls back to a hard-coded `django-insecure-…` `SECRET_KEY` and to `DEBUG=True` when the environment variables are missing. Production sets both, but any deployment that misses the secret would run insecurely.
- `EMAIL_BACKEND` is the console backend, so password-reset and invitation mail is not actually sent in this config.
- Locmem rate-limit cache across 2 replicas × 4 gunicorn workers weakens throttling.
- CircleCI deploys `:latest`. `docker-compose.yml` has dev DB credentials.

## Out of scope / accepted risk

None stated by the user yet.

## Open questions

- JAS-Test-Devin: keep scanning `main`, add a scan pinned to the phase4 branch, or drop it?
- Which attacker profiles matter, and are any ruled out?
- Is anything out of scope or accepted risk (e.g. `microsoft.github.io`, dev-only config, e2e debug specs or the legacy localStorage mode, the console email backend)?
- Which finding tags are wanted besides `Component`?
