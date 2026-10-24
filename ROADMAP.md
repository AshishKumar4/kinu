# Roadmap

What's live on [kinu.run](https://kinu.run), what's coming next, and what I'm building after that. Last updated 2026-10-24. The [changelog](CHANGELOG.md) has the detail for everything that ships.

## Live now

The release of 2026-10-24 (build `8e8bb8c7a`):

- **Pages in chat draw as the answer streams.** A page can read and write the workspace, keep data in the workspace's tables (with SQL), and carry its own server that pushes updates to it. Save keeps the page and its server.
- **Watchers.** A schedule can carry a small check program and fires only when something changed. A push to a GitHub repo wakes it at once, with no polling.
- **One sign-in card for ChatGPT and Claude plans.** The same steps for both. Claude uses Anthropic's code page, and ChatGPT explains its paste step before you leave Kinu.
- **git reaches your private GitHub repos** from the workspace shell and the computer, through your GitHub connection. The agent never sees the token.
- **Interrupted work finishes after a restart.** A step cut off by a reset is checked and redone, never run twice. Reports from helpers survive it too.
- **Linked machines prove who they are with their own key.** A copied device file can't connect as your machine.
- **Mail and Drive look like the rest of the app,** and Settings shows usage per account.
- **Web search uses your own search key** when the shared credits run out.
- **Privacy and terms pages.**

## In progress

- **Claude sign-in in one click.**
- **A quiet indicator for background work.** It shows which helpers and jobs are running, and what's waiting on you.
- **Workspaces placed where every model provider answers.** Anthropic refuses some regions, Hong Kong among them.
- **Computers start fast after a tools update.** An update moves only the files that changed.
- **Deleting a workspace answers at once,** and the cleanup finishes in the background.
- **Several ChatGPT or Claude subscriptions per provider,** added from the web.
- **Google Workspace** (Gmail, Drive, Calendar and more) through one sign-in, waiting on Google's app setup.

## Known limits

- **A workspace created in Hong Kong can't use Claude.** Anthropic refuses that region. Create a new workspace until the placement fix ships.
- **Workspace programs can't use TLS with a custom identity check** (for example mysql2 with SSL). Run those on the computer, where raw TCP with TLS works. Waiting on [Nimbus](https://github.com/AshishKumar4/kinu/issues/60).
- **The workspace shell resolves paths by their text, while the file tools follow links.** Waiting on [Nimbus](https://github.com/AshishKumar4/kinu/issues/56).

## Later

- **Push from Gmail and Calendar to watchers,** so new mail or an event change wakes an agent without polling.
