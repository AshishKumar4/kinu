# Email ingress and outbound

Every address on `EMAIL_DOMAIN` is a box of one account: `<username>@D` the person's own, `<workspace>.<username>@D` a
workspace's, `<agent>.<workspace>.<username>@D` an agent's (docs/MAIL.md §1). Mail to any of them is filed in the
account's Mailbox, and wakes the box's agent only as the Mailbox decides from Cloudflare's own DMARC verdict. The
channel works only after the domain has Email Routing, Email Sending and DNS onboarded, a deploy step (MAIL.md §5).

## Flow

```
inbound   Email Routing (catch-all on EMAIL_DOMAIN)
            → Worker email() handler                     (cf-backend/src/server.ts)
            → handleInboundMail                          (src/mail/handler.ts)
            → routeInboundMail: recipient → label → MailName → account (src/mail/router.ts)
              an unknown address is refused at SMTP time; 25 MiB ceiling, counted
            → the account's MailboxDO.deliver            (src/mail/mailbox-do.ts, store.ts)
              raw bytes to R2, postal-mime parse, Message-ID dedupe, threading, search index
              verdict: the first Authentication-Results under Cloudflare's Received (core mail/verdict.ts)
              wake: the verified owner always; others by the box's policy; unverified never
            → when it woke an agent and is not machine mail:
              the workspace's mailArrived(arrival, actorId)   (src/orchestrator.ts)
              EmailInbox.accept (core/src/events/ingress/email.ts)
              EventLog.publish (email variant): the owner's words, or input's sender and subject only
              + email_thread ReplyChannel for the owner's mail to the workspace's main agent
            → arms the durable wake; the drain runs the turn in Plan (any effect waits for the owner)

outbound  turn completes (onChatResponse)
            → drainTurnId metadata → dispatchEmailRepliesForTurn
                                     (src/email/outbound.ts)
            → email_thread dispatcher → EmailOutbox.send (core/src/events/email-outbox.ts)
              write-ahead intent + stable Message-ID → env.EMAIL.send
              (In-Reply-To / References per RFC 5322, "Re:" subject)

notify    changelog_digest and background-job settles → sendOwnerEmail
          → the same outbox, from noreply@EMAIL_DOMAIN → the owner's login email
          Synthetic-monitoring incidents (src/monitor/incidents.ts) take the
          same path, from ops.monitor@EMAIL_DOMAIN to OPS_ALERT_EMAIL.
```

## Trust model

The trust rule, its measurement and the turn policy are docs/MAIL.md §3-§4. In short:

| Sender | Wakes | Event trust | The turn |
|---|---|---|---|
| The account's sign-in email, DMARC passed by Cloudflare | always | `authenticated` | the owner's instruction, in Plan: reading, planning and drafting run; every effect waits for their in-app approval |
| Anyone else, DMARC passed | by the box's policy (`owner` by default: never) | `external` | untrusted input, in Plan: sender and subject only; the body through `mail.read`, never an instruction |
| Not verified | never | none | none: kept and marked "Not verified" |

## Rate limit

One window per workspace: `EMAIL_INBOUND_RATE_PER_MIN` (30) arrivals a minute across all senders. Past it, mail is
still filed in the Mailbox, but wakes nothing, and the agent is told once per window that its inbox went deaf.
