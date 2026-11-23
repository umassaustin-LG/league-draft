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

Set Vite variables in the frontend build host before `npm run build`.
They are compiled into the bundle, not read at runtime. The Dockerfile and Compose
deploy **only Django**, not the frontend: there is no frontend Docker build stage
to receive build args. Set Vite variables in the separate frontend build environment;
adding them to the API pod would have no effect. The production frontend host is
not configured in this repository. CircleCI builds and persists `dist` but does not
deploy it; the frontend host must supply these production-only build-time values:

```dotenv
VITE_POSTHOG_KEY=phc_sghs577kdfNccVMyU4TUhEsNFr2tgtfYd42E2iTrGjPa
VITE_POSTHOG_HOST=https://us.i.posthog.com
VITE_SENTRY_DSN=https://c5690ed1fd56c7d8e761dc44698565b9@o4512472979865600.ingest.us.sentry.io/4512472994086912
VITE_SENTRY_ENVIRONMENT=production
```

These are public client ingestion keys, not account/API secrets. Do not put these
values in a local `.env`/`.env.local` or test environment: local dev and tests must
remain telemetry-free by default.

The backend production DSN lives in the `league-draft-config` ConfigMap in
`k8s/deployment.yaml` under `sentry-dsn`; `sentry-environment` is `production`.
The Deployment reads both using ConfigMap references. Apply this manifest/config
through the production deployment process; updating only the container image does
not update ConfigMap data. Compose remains opt-in via shell/.env values, with no
DSN by default.

## PostHog project configuration

The production project is **league-draft**, project ID **760406**, in **US cloud**.
Server-side session replay sampling is **25%**, IPs are anonymized, and
**autocapture, console recording, performance capture, and heatmaps are off**.
The project is on the **free plan**. If a payment card is ever added, set **$0
billing limits for every product** before enabling paid usage. Keep the sampling
and privacy settings below as account-side backstops.

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
