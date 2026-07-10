# Mission Inbox — Email Ingress & Outbound

> This document is edited & maintained by Claude and presented as-is.

Every Proteus agent is reachable by email. Mail to `<agent-name>@EMAIL_DOMAIN`
wakes the agent for a turn, and the agent's answer comes back as a real reply
on the same thread. Evolution Changelog digests and background-job completions
also arrive in the owner's inbox. Email is the ambient channel for an
always-on durable agent — no app open, no session.

## Flow

```
inbound   Email Routing (catch-all on EMAIL_DOMAIN)
            → Worker email() handler                    (cf-backend/src/server.ts)
            → routeInboundEmail: recipient → agent name (src/email/route.ts)
              parse MIME once (postal-mime), strip quoted history
            → agent DO: acceptEmailDelivery             (src/orchestrator.ts)
              trust gate → EventLog.publish (email variant, Message-ID dedupe)
              + email_thread ReplyChannel (threading headers, 24h TTL)
            → drainPendingEvents wakes a turn

outbound  turn completes (onChatResponse)
            → drainTurnId metadata → dispatchEmailRepliesForTurn
            → email_thread dispatcher → env.EMAIL.send
              (In-Reply-To / References per RFC 5322, "Re:" subject)

notify    changelog_digest (EvolutionEngine.onEvent) and background-job
          settles (BackgroundJobRunner.onSettled) → sendOwnerEmail
          → the owner's verified login email
```

## Addressing

The local part of the recipient address **is** the agent name (agent names are
globally unique Durable Object ids): `scout-a1b2c3@agents.example.com` routes
to the agent `scout-a1b2c3`. `+tag` sub-addressing and case are tolerated;
anything that isn't a plausible agent slug on `EMAIL_DOMAIN` is dropped.

## Trust model (who can drive a turn)

Inbound email is untrusted input. The gate runs inside the agent DO, before
any event row exists:

| Sender | Outcome | Event trust |
| --- | --- | --- |
| The owner's verified login email (UserDO profile) | admitted | `authenticated` |
| An address on the agent's `email_route` allowlist | admitted | `external` |
| Anyone else | **dropped** (silently — no bounce, no existence oracle) | — |

Notes:

- Even the owner is capped at `authenticated`, never `owner`: email sender
  identity rests on envelope/DMARC checks upstream — weaker than an
  authenticated browser session. The trust lattice then gates tool surface
  exactly as for webhooks.
- The allowlist lives in one `email_route` trigger row with `creator_trust:
  'owner'` — the same trigger registry, trust stamp, and lifecycle
  (pause/revoke/fork-sever) as every other ingress.
- All senders combined share a 30/min inbound rate limit per agent; retried
  deliveries dedupe on `Message-ID`.
- Attachment **metadata** (filename/type/size) enters the turn input;
  attachment bytes never enter the event log.

## Operator API

```
GET /api/agents/<name>/email
  → { address, allowlist, notifications }

PUT /api/agents/<name>/email          (step-up auth: login within 5 minutes)
  { "allow": ["friend@example.com"], "notifications": true }
```

Owner notifications default on (`email_notifications` agent config); they send
only when the platform email pieces below exist, and skip quietly otherwise.

## One-time owner setup (required — nothing works until this is done)

The code ships inert: without these steps no mail arrives and outbound sends
skip quietly. Current config expects `EMAIL_DOMAIN =
proteus.ashishkumarsingh.com` (wrangler.jsonc `vars`); change it there if you
pick a different domain.

1. **Enable Email Routing for the domain** (receiving MX records).
   - Dashboard: zone `ashishkumarsingh.com` → **Email** → **Email Routing** →
     enable. For the `proteus.` subdomain specifically, add it under
     **Email Routing → Settings → Subdomains** (if your plan's dashboard does
     not offer subdomain routing, either set `EMAIL_DOMAIN` to the zone apex
     `ashishkumarsingh.com` or use a dedicated zone).
   - CLI alternative: `npx wrangler email routing enable <domain>` then
     `npx wrangler email routing dns get <domain>` to verify records.
2. **Onboard the same domain for Email Sending** (SPF/DKIM for outbound):
   ```bash
   npx wrangler email sending enable proteus.ashishkumarsingh.com
   npx wrangler email sending dns get proteus.ashishkumarsingh.com   # verify
   ```
3. **Point the catch-all routing rule at the Worker** (catch-all because each
   agent has its own local part):
   - Dashboard: **Email Routing → Routing rules → Catch-all address** →
     action **Send to a Worker** → `proteus`.
   - CLI alternative: `npx wrangler email routing rules create` (see
     `npx wrangler email routing rules --help` for the worker action flags).
4. **Deploy** (the `send_email` binding + `EMAIL_DOMAIN` var are already in
   wrangler.jsonc): `bun run deploy` from `packages/cf-backend`.
5. **Verify**: from your login email, send a message to
   `<agent-name>@proteus.ashishkumarsingh.com`. The agent's timeline shows an
   `email` event, a turn runs, and a threaded reply lands back in your inbox.
   Mail from any other address must be dropped.

Staging (`proteus-staging`) has the binding for parity but no `EMAIL_DOMAIN`,
so the Mission Inbox stays off there.

## Tests

- `packages/core/tests/unit-events-hub-email.test.ts` — trust/priority
  derivation, dedupe, rendering, email_thread channels, the drain path, and
  the CHECK-widening rebuild for live DOs.
- `packages/cf-backend/tests/unit-email-ingress.test.ts` — addressing, MIME
  parse + quote stripping, the sender gate (owner / allowlist / dropped /
  rate limit / duplicate), and the Worker routing seam.
- `packages/cf-backend/tests/unit-email-outbound.test.ts` — the full inbound →
  turn → threaded-reply flow at the seams, threading headers, failure/retry
  audit, and owner notifications. The only mock is the send binding.
