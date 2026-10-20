# Kinu Privacy Policy

Last updated: 20 October 2026

I'm Ashish Kumar Singh, and I run Kinu at kinu.run. This page says what Kinu keeps about you, why, and how to remove it. Questions go to ashishkmr472@gmail.com.

## What Kinu keeps

- **Your account.** When you sign in with Cloudflare, Google or GitHub, Kinu receives your email address, your name and a stable account ID from that provider. It uses them to sign you in and to show your name.
- **What you make in Kinu.** Your chats, files, workspaces, memories, settings and the work your agents do. Kinu needs these to run your agents and show you their results.
- **Credentials you connect.** API keys and sign-ins you give Kinu, such as a model provider key or a Gmail connection. Kinu encrypts them before it stores them, and uses them only to make the calls you set them up for.
- **Mail.** If you use a Kinu mail address, Kinu stores the mail it receives and sends for you.
- **Operational records.** Kinu keeps error reports and usage counts to keep the service running and to fix faults. Error reports from public pages carry no account.

Kinu sets only the cookies that signing in needs. It runs no ads, no ad trackers and no third-party analytics.

## Where it is kept

Kinu runs on Cloudflare. Your data is stored in Cloudflare Durable Objects and R2 storage in Kinu's Cloudflare account.

## Who processes it

- **AI model providers.** To answer you, Kinu sends the relevant part of your conversation and files to the model that runs your request. By default that is Cloudflare Workers AI. If you connect another provider, such as Anthropic or OpenAI, your requests to that model go to that provider under your account.
- **Web search.** When an agent searches the web, the search query goes to the search provider through Cloudflare.
- **Services you connect.** When you connect GitHub, Gmail or another service, Kinu exchanges data with that service on your behalf.

Kinu does not sell your data, and it does not share it with anyone for advertising.

## Google user data

If you connect Gmail, Kinu asks Google for read-only access (`gmail.readonly`).

- Kinu reads your mail only to do what you set it up to do: tell you what needs you, summarise threads, and prepare replies in your Kinu mailbox. It cannot send, change or delete anything in your Gmail.
- Kinu sends the content of a message to the AI model only when it processes that message for you.
- Kinu does not use your Gmail data for advertising, does not sell it, and does not use it to develop, improve or train general AI or machine-learning models.
- No person reads your Gmail data, except with your permission, to investigate a security problem or abuse, or when the law requires it.
- Kinu's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

You can disconnect Gmail at any time in Settings. Kinu then deletes the stored Google credential. You can also remove Kinu's access in your Google Account at https://myaccount.google.com/permissions.

## How Kinu learns

Kinu improves your agents from your own conversations: it adjusts their instructions, memory and skills inside your account. That learning stays in your account. It is not used to train AI models, and it is not shared with other users.

## Deleting your data

Delete your account in Settings › Account. Kinu then deletes your account, workspaces, files, chats, memories, mail and stored credentials. To delete one thing, delete it where it lives in Kinu.

## Children

Kinu is not for children under 13, and I don't knowingly keep data about them.

## Changes

If this policy changes, I'll update the date above and say what changed on this page.
