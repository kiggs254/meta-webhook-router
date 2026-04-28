# shopflow-webhook-router

Multi-tenant fanout middleware for Meta WhatsApp webhooks.

One Meta Tech Provider App → one webhook callback URL (this service) → N Shopflow installations, routed by WABA ID.

## Why

Meta's App Dashboard accepts exactly one webhook callback per App, but one Tech Provider App is reused across many Shopflow installations. Without this router only one installation receives webhooks (template approvals, inbound messages). The router receives from Meta once, verifies the HMAC, then forwards each `entry[]` to the Shopflow install that owns that WABA.

## Architecture

```
Meta TSP App ──► POST /meta/webhooks ──► delivery_log rows (per entry)
                                         │
                                         ▼
                                     Dispatcher (in-process worker)
                                         │
                                         ├──► Shopflow install A /api/v1/webhooks/meta
                                         ├──► Shopflow install B /api/v1/webhooks/meta
                                         └──► …
```

- Meta → router: verified with `x-hub-signature-256` + `META_APP_SECRET`.
- Router → Shopflow: signed with `x-shopflow-signature-256` + per-registration `forward_secret`.
- Retries: exponential backoff up to `FORWARD_MAX_RETRIES` (default 6).
- ACK to Meta is ~O(single DB insert per entry) — fanout is async.

## Tenants & registrations

A **tenant** is a coarse auth unit (one per product or region: `shopflow-v2`, `cleanshelf`, `homechef`, …). A **registration** maps a WABA ID to a forward URL under a tenant. Shopflow installations call the registrations API themselves when they complete Embedded Signup.

## Deploy

### Prerequisites

- Node 20+
- PostgreSQL 14+

### Environment

```bash
cp .env.example .env
# fill in DATABASE_URL, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN
```

### Install & run

```bash
npm install
npm run build
npm start           # production
# or
npm run dev         # watch mode
```

Schema is created automatically on first boot (`sequelize.sync`).

### Create a tenant

```bash
npm run tenant:create -- --id shopflow-v2 --name "Shopflow v2 installations"
```

Copy the printed secret into every Shopflow installation's env:

```
WEBHOOK_ROUTER_URL=https://webhooks.example.com
WEBHOOK_ROUTER_TENANT_ID=shopflow-v2
WEBHOOK_ROUTER_TENANT_SECRET=<secret from CLI>
```

List tenants + their registrations:

```bash
npm run tenant:list
```

Rotate a secret:

```bash
npm run tenant:create -- --id shopflow-v2 --regenerate
```

### Point Meta at the router

In the Meta App Dashboard → WhatsApp → Configuration → Webhooks:

- **Callback URL**: `https://<router-host>/meta/webhooks`
- **Verify token**: value of `META_WEBHOOK_VERIFY_TOKEN`
- **Fields**: subscribe `messages` and `message_template_status_update`

## Embedded-signup proxy

Meta requires every domain that loads the Facebook JS SDK for embedded signup to be on the App's "Allowed Domains for the JavaScript SDK" list. Adding every Shopflow installation domain doesn't scale, so the router can serve the signup page itself on its single whitelisted domain and relay results back to each installation.

### Setup

1. Whitelist **only the router's host** in Meta App Dashboard → Settings → Advanced → JavaScript SDK Allowed Domains.
2. Set on the router:
   ```
   META_APP_ID=<TSP App ID>
   META_EMBEDDED_SIGNUP_CONFIG_ID=<Business config ID>
   META_SOLUTION_ID=<optional, Solution Partners only>
   ```
3. On each Shopflow install, set `META_EMBEDDED_SIGNUP_PROXY_URL=https://<router-host>` and restart the admin backend. To run an install standalone (loading the SDK on its own domain), leave the var unset.

### Flow

```
Shopflow admin                 Router                       Meta
─────────────                  ──────                       ────
window.open(/embedded-signup/start
  ?tenant_id=…&state=…&parent_origin=…) ─►
                              serves HTML, loads sdk.js,
                              runs FB.login           ─►
                                                       ◄─ postMessage WA_EMBEDDED_SIGNUP
                                                          (waba_id, phone_number_id, …)
                              FB.login returns { code }
                              window.opener.postMessage(
                                {code, event, waba_id, …},
                                parent_origin)              ─►
admin verifies state matches, posts the same payload to its existing
POST /api/v1/whatsapp/onboarding/complete (which exchanges the code
with Graph API using the install's own META_APP_SECRET).
```

The router never sees the auth code or any access token — those live only in the browser and the originating Shopflow backend.

## API

### Webhook (public, Meta-signed)

- `GET  /meta/webhooks` — subscription verification.
- `POST /meta/webhooks` — Meta events. Raw body required for HMAC verification.

### Registrations (tenant-signed)

Required headers:
- `x-shopflow-tenant-id: <tenant_id>`
- `Authorization: Bearer <shared_secret>`

```
PUT /api/v1/registrations
    body: { waba_id, forward_url, forward_secret }

GET /api/v1/registrations/:waba_id
DELETE /api/v1/registrations/:waba_id
```

`forward_secret` is a per-installation HMAC secret. The router signs every forwarded event with it (`x-shopflow-signature-256`). Installations verify with the same secret — `META_APP_SECRET` is no longer needed on the installation side for inbound webhooks.

### Forwarded payload

Each event from Meta is re-fanned out as one HTTP POST per `entry[]`:

```
POST <forward_url>
Content-Type: application/json
x-shopflow-signature-256: sha256=<hex hmac sha256 (forward_secret, body)>
x-shopflow-waba-id: <waba_id>
x-shopflow-delivery-id: <numeric delivery id, for idempotency>

{ "object": "whatsapp_business_account", "entry": [ <single entry> ] }
```

Installations must return a 2xx within 4s (`FORWARD_TIMEOUT_MS`). 4xx other than 429 is treated as permanent failure; 5xx / 429 / network errors retry with exponential backoff.

## Operations

### Inspect delivery log

```sql
SELECT id, waba_id, field, status, retry_count, last_http, last_error, created_at, delivered_at
FROM delivery_log
ORDER BY id DESC
LIMIT 50;
```

### Health

- `GET /health`   liveness
- `GET /health/db` readiness (pings the DB)
