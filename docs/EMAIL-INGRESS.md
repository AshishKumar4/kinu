# Mission Inbox — Email Ingress & Outbound

Every Kinu agent is reachable by email. Mail to `<workspace-name>@EMAIL_DOMAIN`
wakes the agent for a turn, and the agent's answer comes back as a real reply
on the same thread. Evolution Changelog digests and background-job completions
arrive in the owner's inbox over the same outbound path, and
synthetic-monitoring alerts use it to reach `OPS_ALERT_EMAIL`. Email reaches an
always-on durable agent with no app open and no session.

## Flow

```
inbound   Email Routing (catch-all on EMAIL_DOMAIN)
            → Worker email() handler                    (cf-backend/src/server.ts)
            → handleInboundEmail                        (src/email/handler.ts)
            → routeInboundEmail: recipient → workspace name (src/email/route.ts)
              parse MIME once (postal-mime), strip quoted history
            → agent DO: acceptEmailDelivery             (src/orchestrator.ts)
              EmailInbox.accept (core/src/events/ingress/email.ts)
              trust gate → EventLog.publish (email variant, Message-ID dedupe)
              + email_thread ReplyChannel (threading headers, 24h TTL)
            → scheduleDrain() wakes a turn (debounced; duplicates don't re-wake)

outbound  turn completes (onChatResponse)
            → drainTurnId metadata → dispatchEmailRepliesForTurn
                                     (src/email/outbound.ts)
            → email_thread dispatcher → EmailOutbox.send (src/email/outbox.ts)
              write-ahead intent + stable Message-ID → env.EMAIL.send
              (In-Reply-To / References per RFC 5322, "Re:" subject)

notify    changelog_digest (EvolutionEngine event listener) and background-job
          settles (BackgroundJobRunner.onSettled → notifyOwner) → sendOwnerEmail
          → the same outbox → the owner's verified login email
          Synthetic-monitoring incidents (src/monitor/incidents.ts) take the
          same sendOwnerEmail + outbox path, from ops.monitor@EMAIL_DOMAIN to
          OPS_ALERT_EMAIL rather than to a workspace owner.
```

## Addressing

The local part of the recipient address **is** the workspace name. Workspace
names are globally unique Durable Object ids, so
`scout-a1b2c3@agents.example.com` routes to the workspace `scout-a1b2c3` and
wakes its agent. `+tag` sub-addressing is stripped and case is ignored. A local
part that is not a plausible workspace slug, or a host that is not
`EMAIL_DOMAIN`, is dropped.

## Trust model (who can drive a turn)

Inbound email is untrusted input. The gate runs inside the agent DO, before any
event row exists:

| Sender | Outcome | Event trust |
| --- | --- | --- |
| The owner's verified login email (UserDO profile) | admitted | `authenticated` |
| An address on the agent's `email_route` allowlist | admitted | `external` |
| Anyone else | **dropped** (silently, so no bounce and no existence oracle) | n/a |

Notes:

- Even the owner is capped at `authenticated` and never `owner`. Email sender
  identity rests on envelope and DMARC checks upstream, which is weaker than an
  authenticated browser session. The trust lattice then gates tool surface
  exactly as for webhooks.
- The allowlist lives in one `email_route` trigger row with `creator_trust:
  'owner'`, in the same trigger registry, with the same trust stamp and the
  same lifecycle as every other ingress. Archiving the workspace pauses the row
  (`state='paused'`), and deleting it revokes the row (`state='revoked'`).
  Verified 2026-08-19 in `core/src/events/hub/triggers.ts`.
- `email_route`'s fork policy is `sever`, so a forked workspace inherits no
  email route. A fork has its own address, and the owner re-grants the
  allowlist deliberately. Fork policy is a separate column from lifecycle
  state; `copy`, `sever` and `share` are its three values.
- All senders combined share one inbound rate-limit window of **30 messages per
  minute per agent** (`EMAIL_INBOUND_RATE_PER_MIN`, verified 2026-08-19). A
  refused window also publishes one internal `email_inbound_rate_limited`
  event, so the agent can report the refusal rather than silently miss mail.
- Retried deliveries dedupe on `Message-ID`, enforced by a UNIQUE index on
  `agent_log.dedupe_key`. Mail carrying no `Message-ID` falls back to a hash of
  from, to, subject and body, bucketed in 5-minute windows. Verified
  2026-08-19 in `core/src/events/hub/dedupe.ts`.
- Attachment **metadata** enters the turn input as `filename`, `content_type`
  and `size`. Attachment bytes never enter the event log. Verified 2026-08-19
  in `core/src/events/hub/types.ts` (`EmailAttachmentMeta`).
- A body larger than the brief budget is spilled to a workspace path, so the
  woken turn can read the whole message it was woken by.
- RFC 3834 auto-replies and bulk mail are dropped inbound. Kinu auto-replies
  on-thread, so admitting another machine's vacation responder would loop the
  two forever.

## Operator API

```
GET /api/workspaces/<name>/email
  → { address, allowlist, notifications }

PUT /api/workspaces/<name>/email          (step-up auth: login within 5 minutes)
  { "allow": ["friend@example.com"], "notifications": true }
```

Widening who can drive turns by email is a grant, so `PUT` takes the same
step-up rule as webhook trigger creation. Owner notifications default on
(`email_notifications` agent config). They send only when the platform email
pieces below exist, and skip quietly otherwise.

## One-time owner setup, required before anything works

The code ships inert. Without these steps no mail arrives and outbound sends
skip quietly. Current config expects `EMAIL_DOMAIN = kinu.run`
(wrangler.jsonc `vars`); change it there if you pick a different domain.

1. **Enable Email Routing for the domain** (receiving MX records).
   - Dashboard: zone `kinu.run` → **Email** → **Email Routing** → enable.
   - CLI alternative: `npx wrangler email routing enable kinu.run` then
     `npx wrangler email routing dns get kinu.run` to verify records.
2. **Onboard the same domain for Email Sending** (SPF/DKIM for outbound):
   ```bash
   npx wrangler email sending enable kinu.run
   npx wrangler email sending dns get kinu.run   # verify
   ```
3. **Point the catch-all routing rule at the Worker.** It has to be a catch-all,
   because each agent has its own local part.
   - Dashboard: **Email Routing → Routing rules → Catch-all address** →
     action **Send to a Worker** → `kinu`.
   - CLI alternative: `npx wrangler email routing rules create` (see
     `npx wrangler email routing rules --help` for the worker action flags).
4. **Deploy.** The `send_email` binding and the `EMAIL_DOMAIN` var are already in
   wrangler.jsonc, so this is `bun run deploy` from the repo root.
5. **Verify.** From your login email, send a message to
   `<workspace-name>@kinu.run`. The agent's timeline shows an
   `email` event, a turn runs, and a threaded reply lands back in your inbox.
   Mail from any other address must be dropped.

Staging (`kinu-staging`) has the binding for parity but no `EMAIL_DOMAIN`,
so the Mission Inbox stays off there.

## Tests

- `packages/core/tests/unit-events-hub-email.test.ts`: trust/priority
  derivation, dedupe, rendering, email_thread channels, the drain path, and
  the CHECK-widening rebuild for live DOs.
- `packages/cf-backend/tests/unit-email-ingress.test.ts`: addressing, MIME
  parse + quote stripping, the sender gate (owner / allowlist / dropped /
  rate limit / duplicate), and Worker routing.
- `packages/cf-backend/tests/unit-email-outbound.test.ts`: the full inbound →
  turn → threaded-reply flow at its boundaries, threading headers,
  failure/retry audit, and owner notifications. The only mock is the send
  binding.
- `packages/cf-backend/tests/unit-email-outbox.test.ts`: the write-ahead
  intent log: idempotency keys, the stable Message-ID, and the reconciliation
  sweep that re-drives a send left pending by a crash.
