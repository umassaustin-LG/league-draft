# Optional monitoring

Monitoring is disabled when its DSN/key is unset. No credentials are required to
build or run the app. Frontend public ingestion keys are not account/API secrets.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SENTRY_DSN` | Vite build environment | Enables browser Sentry |
| `VITE_SENTRY_ENVIRONMENT` | Vite build environment | Environment label |
| `VITE_POSTHOG_KEY` | Vite build environment | Enables PostHog |
| `VITE_POSTHOG_HOST` | Vite build environment | Defaults to `https://us.i.posthog.com` |
| `SENTRY_DSN` | Django runtime | Enables backend Sentry |
| `SENTRY_ENVIRONMENT` | Django runtime | Environment label |

Set Vite variables before `npm run build` (or in a local uncommitted `.env.local`).
They are compiled into the bundle, not read at runtime. The Dockerfile and Compose
deploy **only Django**, not the frontend: there is no frontend Docker build stage
to receive build args. Set Vite variables in the separate frontend build environment;
adding them to the API pod would have no effect. Compose passes backend values from
the shell/.env. Kubernetes accepts optional `sentry-dsn` in `league-draft-secrets`
and `sentry-environment` in `league-draft-config`.

## Privacy and volume

Shared recursive browser scrubbing is used by Sentry events, transactions and
breadcrumbs and PostHog properties. The backend uses the same sensitive-key list
and email/phone patterns. Sensitive fields are redacted, request bodies, headers,
cookies and query fields are removed, and query strings/fragments are stripped from
URLs. User context retains only an opaque ID; the app does not call PostHog identify.
Avoid putting personal information in URL paths, arbitrary prose or custom event names:
regex scrubbing cannot recognize every free-form name or address.

Sentry disables default PII and request body capture (and backend locals), samples
traces at 10%, and masks replay text, inputs and media. Both session and error
replay rates are 25% (these are separate cohorts, not a strict combined 25% cap).
PostHog autocapture is off; replay masks inputs/all text and only starts for a
client-side 25% session sample. Pageviews are enabled. Sampling reduces volume;
it is not a dollar budget guarantee.

## Required account-side cost and privacy backstops

Before enabling keys in any environment:

* **Sentry — Settings > Subscription:** set on-demand/pay-as-you-go budget to **$0**.
* **Sentry — Settings > Spike Protection:** enable for **all projects**.
* **PostHog — Billing:** set a **$0 billing limit on every product**, including
  product analytics, session replay, and any other enabled products.
* **PostHog project settings:** set session replay sampling to **25%** as a
  server-side backstop and enable **mask all inputs/text**.

These account settings cannot be enforced by this repository. Review retention,
access permissions and consent requirements before enabling youth-data telemetry.
