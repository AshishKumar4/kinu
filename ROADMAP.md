# Roadmap

What's live on [kinu.run](https://kinu.run), what's coming in the next release, and what I'm building after that. Last updated 2026-10-19. The [changelog](CHANGELOG.md) has the detail for everything that ships.

## Live now

The release of 2026-10-17 (build `bc78a94bd`):

- **The Environment tab is one row of machines and one row of sessions.** No second sidebar; the terminal or desktop fills the rest, and panes stay mounted when you switch.
- **Files opens as tiles.** A view menu switches between list and tiles, and shows or hides dotfiles and a machine's own system folders.
- **Sounds only when you're away.** A soft chime and a browser notification when a turn finishes or something needs you, and only while you're away from every Kinu tab on every device. One alert, not one per tab. A switch in Settings turns sounds off.
- **Websites in the computer's browser load over HTTPS without warnings,** and the browser no longer offers to restore pages after a restart.
- **Each workspace gets its own logo look.**
- **A computer whose disk stops answering can be restarted with a second Stop,** and its status says it's waiting on its disk.

## In the next release

Merged and in testing:

- **Long computer-use sessions stay fast.** Each step costs the same no matter how many screenshots came before.
- **Files you upload keep their names,** in `/uploads`.
- **Web search moves to Cloudflare's Web Search API,** replacing a scraper that failed most of the time.
- **Tool calls fold into one line while the agent works.** A live view scrolls inside it, and it settles into a summary ("Used 22 tools · 1 failed") once the answer starts. The answer, questions and approvals always stay in view.
- **Shorter, more visual answers.** The agent's instructions now ask for direct answers, and for inline slates for anything visual or interactive instead of long markdown tables.
- **A message you send during a long tool call goes through at once.** The call moves to the background, and the agent answers you with the job still running.
- **An agent can see what's waiting on you** (approvals, questions, consents) and be woken when you've handled it.
- **Stop, then Continue, keeps its order,** and words a Stop hands back return to your draft.
- **On a Mac, the device daemon keeps file changes inside the folders you shared.**
- **Faster evals.** One shared queue instead of fixed lanes.

## In progress

- **Sharing slates.** Share a live slate by link or with people you add. In the default mode everyone uses their own accounts, and what's personal to you stays private. An opt-in mode lends your access, and every change it makes asks you first. Collaborators can edit, and slates can be listed in a Gallery and forked. It's in security review, and it ships when that review passes.
- **A cleaner sidebar,** with a compact header and a new-workspace button in place of the big one.
- **System notices in chat, cleanly formatted:** a short summary instead of raw text and tags, centred, and as wide as the chat when opened.
- **GitHub and Google connections** through their own sign-in screens.
- **A smaller, consistent tool surface for agents** (planned): one name and one shape for each action on every machine.
- **A computer-use benchmark where the agent plays Minecraft Classic by hand.**

## Known limits

- **Workspace programs can't use TLS with a custom identity check** (for example mysql2 with SSL). Run those on the computer, where raw TCP with TLS works. Waiting on [Nimbus](https://github.com/AshishKumar4/kinu/issues/60).
- **The workspace shell resolves paths by their text, while the file tools follow links.** Waiting on [Nimbus](https://github.com/AshishKumar4/kinu/issues/56).

## Later

- **A new landing page** ([#12](https://github.com/AshishKumar4/kinu/issues/12)).
