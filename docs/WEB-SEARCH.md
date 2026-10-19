# Web search decisions

The `web` tool's search: which providers Kinu offers, who pays for a search, and what happens when one refuses. The code is `packages/core/src/providers/web-search.ts` (the registry), `packages/core/src/web/search-chain.ts` (the chain) and `packages/cf-backend/src/components/account/WebSearchSettings.tsx` (Settings and onboarding). One entry per decision, with the measurement that settled it.

## W1. A provider is offered when it answers the 36 questions well (2026-10-19)

Each candidate runs the same 36 questions (6 each: fresh news, docs lookups, pricing pages, code errors, long-tail facts, local and how-to), 5 results each, graded blind by one model call against a fixed rubric: relevance 0 to 4, answerable from the first three results, current as of 2026-10-19, any junk. A provider with its own API enters the registry at a mean relevance of 3.0 or more, under terms that allow an agent's use.

Measured through Cloudflare's Web Search API (`POST /accounts/{id}/ai/websearch/`, gateway `kinu-ai-gateway-staging`):

| Provider | Mean relevance | Answerable | Current | Any junk | Median latency | List price per 1,000 |
| --- | --- | --- | --- | --- | --- | --- |
| Exa | 3.92 | 35/36 | 35/36 | 3/36 | 1874 ms | $7.00 |
| Linkup | 3.17 | 32/36 | 26/36 | 21/36 | 1602 ms | $5.00 |
| Ceramic.ai | 1.72 | 11/36 | 11/36 | 18/36 | 525 ms | $0.25 |

Exa is Kinu's default (commit 2d9afcb03). All three of the API's indexes are offered, Ceramic.ai included, on the owner's call (2026-10-19); the 3.0 bar governs providers with their own API.

Closed to new customers, so not candidates: Google's Custom Search JSON API (developers.google.com/custom-search/v1/overview: no new customers, discontinued 2027-01-01) and Bing Web Search (retired 2025-08-11, learn.microsoft.com lifecycle notice).

## W2. A search through Cloudflare bills the account that granted it (2026-10-19)

A person who signed in with Cloudflare and whose sign-in grants `websearch.run` searches on their own account's gateway (the one selected in Settings, else `default`), through the REST API with their login, billed to that account's AI Gateway credits. Everyone else searches on the deployment's own gateway through its AI binding, billed to the deployment's account. When the person's own gateway refuses (a 402 for spent credits), they read Cloudflare's words; Kinu never moves the search to the deployment's bill (owner, 2026-10-19).

Measured: Kinu's OAuth client may request `websearch.run` (dash.cloudflare.com/oauth2/auth went on to the login; an unknown scope was refused with `invalid_scope`). A Cloudflare API token needs Workers AI Read and AI Gateway Read (developers.cloudflare.com/web-search/how-to-use): two tokens holding AI Gateway but not Workers AI Read were refused 403 `Authentication error`.

Hypothesis, unmeasured: that an OAuth token needs `websearch.run` rather than `ai.write` alone. A sign-in from before this change holds no `websearch.run`, so its searches stay on the deployment's bill until the person signs in again.

## W3. A person's own key is called directly, never stored on their gateway (2026-10-19)

AI Gateway can hold a provider key for Web Search (`byokAlias`), and its API can store one (`POST /accounts/{id}/ai-gateway/gateways/{gateway}/provider_configs` with `secret`, permission Secrets Store Write). Kinu's OAuth client is refused every Secrets Store scope (`secrets_store.write`, `secrets_store:write`, `secrets-store.write`: `invalid_scope`, 2026-10-19), and gateway keys reach only the providers Cloudflare's API serves. So a key a person pastes is sealed with their other credentials and sent only to that provider's own API.

## W4. The chain is the account's, and fails over as a model's does (2026-10-19)

The account's chain is its profile catalog's `webSearch`, beside `retries`, read by both backends; absent is Exa through Cloudflare. A refusal hands over at once to the next entry and parks the refused one for whoever pays for it until its Retry-After, else the provider pacer's own wait; the last entry is asked again up to `retries` times after a refusal that may pass (408, 429, 5xx, a dropped connection). A request a provider calls malformed ends the search. An entry nobody can pay for (no key stored, no Cloudflare account and no deployment gateway) is passed over and never parked, so a key stored a moment later is used by the next search.
