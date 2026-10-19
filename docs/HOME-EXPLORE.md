# Home, the personal assistant, workspace blueprints, Explore and the shell

Design for the owner's review, 2026-10-19. Nothing here is built past its wireframe until the owner approves it, and nothing that exists is removed or replaced without that approval: every removal and replacement is listed in §8. Wireframes are the product's own components in the design gallery (§10).

## 1. What the owner asked for

Workspace blueprints that can be whole workspaces, not one slate. A first-party Personal assistant blueprint, selected by default during setup, as capable and as polished as the best personal agents: it triages mail, briefs the owner, watches GitHub and Google, creates and coordinates workspaces, and does real work through Kinu's tools and computer. A focus layout. Home as the assistant's chat when it is installed. Explore in place of Gallery, one feed of apps and workspaces. A sidebar with Home, Workspaces, Drive, Explore and Plugins, and a footer holding the account, Mail and Devices.

The rule throughout: use, reuse and compose what Kinu has. Each piece below names the existing parts it is made of.

## 2. The personal assistant

It is a workspace, installed from the first-party blueprint `personal-assistant`. Its main agent is called Kinu unless the owner renames it, it has one chat, and its layout is focus. Every other piece of work happens in workspaces of its own, which it proposes, starts and checks on.

| It does | Made of |
| --- | --- |
| Reads mail and marks what matters, with one line on why | The workspace's mail address (`<name>@kinu.run`, Mission Inbox, `email_route` trigger) and the Gmail MCP preset; Mail's Important view and its reason line (feat/mail, `ImportantMailRow`) |
| Drafts replies; sending waits for the owner | A draft lands in Mail's Drafts; a send it asks for is a Needs-you card (`mail_send`, feat/mail's `MailSendBody`) |
| Briefs the owner each weekday at the time they chose | A cron trigger (`agent.schedule`) whose turn writes the brief into its chat |
| Watches GitHub and Cloudflare | Cron triggers that read through the GitHub and Cloudflare MCP presets the owner connected; each firing is a turn, quiet unless it found something |
| Creates and coordinates workspaces | Workspace proposals (Needs-you, Create / Decline, its soul shown on the card); peer messages to a workspace's main agent; each workspace's overview tile for how far it has come |
| Real work | Kinu's tools, its computer and devices, as any workspace has them |
| Asks before acting | The existing approval queue: deferred actions, standing approvals, workspace proposals, device consent. Defaults are read-only: sending mail, creating a workspace, starting work in another workspace, writing to GitHub and deploying each wait for a card |
| Remembers | The account memory and the workspace's memory, readable and editable where they are today (Settings › Memory, the inspector's Agent tab) |

Calendar is not in it: Kinu has no calendar connection, and the design adds none.

### Home with the assistant

`/` renders the assistant's workspace page in the focus layout, with Today above its chat (wireframe `assistant-home`).

- **The bar** says who you are talking to and what it is doing: its mascot, its name, and a line ("Watching 4 · brief tomorrow 08:00", or what it is working on). Its agents, settings and inspector sit at the bar's end, as on every workspace.
- **Today** is four tiles, each one glance and a list beneath when opened: Needs you (the assistant's own asks, and each workspace with decisions waiting), Important (unread Important mail, the reason on each row), Workspaces (the ones it runs, each with its status and how far its plan has come), Watching (each trigger, what it last found, when it next looks). Hide folds it to one line.
- **The chat** carries the brief, mail arrivals as event pills, and its answers. Its Needs-you cards sit in the composer's stack, as in any workspace.

Today is built from reads Kinu keeps: the roster's tiles (`workspace_overviews`), the assistant's pending actions (`ownerAsks`), Mail's Important (`GET /api/user/mail/important`), and the assistant's triggers (`listTriggers`) with the line each one's last turn wrote as its finding (`last_finding`, §9.3). One addition: a workspace's tile carries its active plan's title and done/total (`plan` in the overview JSON), which is how a workspace pursuing a goal shows its progress.

### First run

Setup's new step "A personal assistant" opens with Yes chosen, so Next installs it; Not now leaves Home as it is, and Explore keeps it. The step shows its name (editable), the address that will reach it, the connections it will read and whether each is connected, the brief time, and that it asks before it sends, creates or starts anything. Finishing setup installs it and opens Home on its first message: what it can reach, and three concrete first jobs drawn from what is connected (wireframe `assistant-home&moment=firstrun`).

### Progress

- A **workspace** it runs: status dot, its headline (Working, Needs you · n, Last run failed), its plan's title and a done/total bar, in Today's Workspaces; the brief names what each did overnight.
- A **watch**: its last finding in a line, checked and next times, in Today's Watching; a firing that found something becomes a turn in the chat, opened by its event pill.

## 3. The focus layout

A workspace keeps a layout, `workbench` (today's) or `focus`, in its root actor's config (`layout`), so every browser shows it alike and a blueprint can set it. Focus draws the chat alone at the reading width: the bar shows who is talking in place of the chat tabs (a Chats button reveals them when there is more than one), the inspector starts closed and never opens by itself for what waits on the owner, and the agents stay behind the bar's agents button. The phone shows one bar. Any workspace can choose it in its settings (wireframe `focus-workspace`).

## 4. Workspace blueprints

One concept for slates and workspaces: a blueprint is what a new thing of yours starts from. A slate blueprint is unchanged. A workspace blueprint is a manifest:

| Field | Holds |
| --- | --- |
| title, line, category, picture | What Explore shows |
| soul | The new workspace's SOUL.md, with `{{owner}}` filled in at install |
| agents | The main agent's name, and any durable agents |
| automations | Its triggers: cron schedules and their prompts, the email route |
| slates | Slate blueprints (existing publications), admitted into the new workspace |
| needs | Connections (MCP presets) at an access level, and secrets by name, each with why |
| asks | What it stops and asks before doing: its approval defaults |
| layout | `workbench` or `focus` |

Publishing one is Share › Blueprint from a workspace's settings: inspect (what it holds, secret-shaped text found, as slate blueprints do), then publish a version and a revocable share. Installing one makes a new workspace through today's create path (`CreateCloudWorkspaceInputSchema` gains `blueprint`), seeds its soul, config and triggers, admits its slates, and records where it came from (`blueprint` in the root's config). A later version never changes an installed workspace.

Kinu's own blueprints (Personal assistant, Worker on-call, Release manager, Research desk) live in code, are listed first, and carry Kinu as maker.

## 5. Explore

Explore replaces Gallery in the nav (wireframe `explore`). One feed of apps (listed slates, the Gallery's listings) and workspaces (listed workspace blueprints), ranked as the Gallery ranks today (trending by this week's stars, then all-time, then newest), with Kinu's own featured at the top and the personal assistant leading. Kind, category and sort are chips; search reads titles and lines of both kinds.

A card shows its picture, a kind badge (App or Workspace), title and line, its maker (Kinu marked as such), its numbers (people who opened an app, installs of a workspace; stars), what it needs of yours (a mark per connection, a key per secret, or "Needs nothing of yours"), and its verb: Open or Install.

An app's page is the Gallery's slate page as it is. A workspace's page (wireframe `explore-workspace`) shows what it does, what a new workspace holds (agents, schedules and watches, slates, layout, its soul), what it needs of yours and whether you already have each, and what it asks first; Install opens a dialog with its name, for the assistant its brief time and whether it becomes Home, and each connection connected or to connect (wireframe `&install=1`).

## 6. The shell

Nav: Home, Workspaces, Drive, Explore, Plugins (Plugins stays, by the owner's word). The footer: the account (avatar and name) opening a menu with Settings, the theme, Feedback, Control plane for admins, and Sign out; beside it Mail, badged with unread Important, and Devices. The Kinu mark at the top goes Home. The folded rail ends with Mail, Devices and the account. Committed: 98221d892.

## 7. Routes and reads

| Route | Answers |
| --- | --- |
| `GET /explore`, `/explore/workspaces/:id` | Pages (app routes) |
| `GET /api/explore?q&kind&category&sort&page` | `{ items: ({kind:'app', app, needs} \| {kind:'workspace', workspace})[], next }` |
| `GET /api/explore/workspaces/:id` | The blueprint page: card, about, inside, asks, version |
| `POST /api/explore/workspaces/:id/install` | `{ name, brief? }` → `{ workspace }` |
| `POST /api/explore/workspaces/:id/star`, `/report` | As the Gallery's |
| `GET /api/user/mail/important?limit=` | Mail lane's; the footer badge and Today |

## 8. Removals and replacements, for the owner's approval

Each is a change to something that exists; none lands without approval.

1. **Home** (`/`): with the assistant installed, Home is its chat and Today, in place of "What do you wanna work on?", the Setup card and Recent. Without it, Home is unchanged.
2. **New workspace** (the pencil beside the mark): today it goes to Home's mission prompt. With the assistant installed it opens that prompt on the Workspaces page instead.
3. **The assistant's workspace in the sidebar**: not listed among Workspaces, because it is Home.
4. **Gallery in the nav** becomes Explore. `/gallery` stays, and a listed slate's page `/gallery/:workspace/:slate` is unchanged; the Gallery's list page becomes Explore filtered to apps.
5. **Devices in the nav** moves to an icon in the sidebar footer. Its page and Settings › Devices are unchanged.
6. **The account menu at the top left** (the Kinu mark and caret) moves to the footer; the mark becomes a link Home. Its items are unchanged.
7. **The folded rail's account initial** opens the account menu instead of going to Settings, and Mail and Devices join it.
8. **The swarm explorer's route key** is renamed `explore` → `swarm` in `APP_ROUTES`, so `explore` can name Explore. Its path `/swarm/:agentId` is unchanged.
9. **The Gallery's tables** (`gallery_listings`, `gallery_stars`, `gallery_reports`) take a `kind` and become Explore's one store for apps and workspaces; `slate` is renamed `item`, which drops today's Gallery stars and reports on repair; `gallery_listings` gains `maker`, `needs` and `installs`, and `gallery_installs` is new (§9.1).
10. **The workspace bar** shows the focus bar in a focus-layout workspace; workbench workspaces are unchanged.
11. **`triggers`** gains `last_finding`, the line Today shows under each watch (§9.3).

## 9. DDL

One listings store for both kinds: the Gallery's three control-plane tables take a `kind`, and a fourth counts installs beside them. A workspace's own published blueprints sit beside its slate publications. No other table changes.

### 9.1 The control plane: one store for Explore (`gallery_listings`, `gallery_stars`, `gallery_reports`, generalized)

```sql
CREATE TABLE gallery_listings (
  kind TEXT NOT NULL DEFAULT 'app' CHECK (kind IN ('app', 'workspace')),
  workspace TEXT NOT NULL,
  item TEXT NOT NULL,
  share TEXT NOT NULL,
  title TEXT NOT NULL,
  line TEXT NOT NULL,
  category TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  maker TEXT NOT NULL DEFAULT 'person' CHECK (maker IN ('person', 'kinu')),
  url TEXT NOT NULL,
  picture TEXT,
  needs TEXT,
  listed_at INTEGER NOT NULL,
  viewers INTEGER NOT NULL DEFAULT 0,
  installs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, workspace, item)
);

CREATE TABLE gallery_stars (
  kind TEXT NOT NULL DEFAULT 'app' CHECK (kind IN ('app', 'workspace')),
  workspace TEXT NOT NULL, item TEXT NOT NULL, email TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (kind, workspace, item, email)
);

CREATE TABLE gallery_reports (
  kind TEXT NOT NULL DEFAULT 'app' CHECK (kind IN ('app', 'workspace')),
  workspace TEXT NOT NULL, item TEXT NOT NULL, email TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (kind, workspace, item, email)
);

CREATE TABLE gallery_installs (
  kind TEXT NOT NULL CHECK (kind IN ('app', 'workspace')),
  workspace TEXT NOT NULL, item TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (kind, workspace, item, user_id)
);
```

Indexes as today: `gallery_stars_email(email)`, `gallery_stars_at(at)`, `gallery_reports_email(email)`.

- `item` replaces `slate`: a slate's id for an app, a blueprint share's id for a workspace. Schema repair keeps only matching columns, so today's listings rebuild from their listing sync and today's stars and reports are dropped; decided for clarity (2026-10-19), as the deployment has almost no users.
- `maker = 'kinu'` marks Kinu's own blueprints. They are code, and the control plane writes their rows when it starts, under workspace `kinu`, so they rank, star and count installs like any other.
- `installs` is the count of `gallery_installs`, as `viewers` is of the opens a workspace reports; an app's install is a fork.
- `needs` is what an item reaches of its opener's, JSON, written by its listing sync.

### 9.2 A workspace's own Durable Object: its published blueprints (beside `slate_publications` and `slate_shares`)

```sql
CREATE TABLE workspace_blueprint_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_blueprint_shares (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES workspace_blueprint_versions(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('link', 'public')),
  listing_line TEXT,
  listing_category TEXT CHECK (listing_category IS NULL OR listing_category IN ('work', 'money', 'home', 'developer', 'fun')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((listing_line IS NULL) = (listing_category IS NULL)),
  CHECK (listing_line IS NULL OR visibility = 'public')
);
```

`manifest` is the §4 manifest as JSON, its slates as publication ids of this workspace; `picture` a capture's digest, kept as slate pictures are. A listed share is synced into `gallery_listings` as `kind = 'workspace'`, as a listed live share is as `kind = 'app'`.

### 9.3 A trigger's last finding

```sql
-- triggers (each workspace): what the watch's last firing found, in a line, written by the turn it began.
last_finding TEXT
```

### No DDL

- The installed assistant: `user_config` key `assistant` (its workspace's name).
- A workspace's layout and where it came from: `actor_config` keys `layout` and `blueprint` on its root.
- A workspace's plan progress: the `plan` field of the overview JSON in `workspace_overviews.overview`.

## 10. Wireframes

Published as `home-explore` on the review server: `/live/home-explore/gallery.html?frame=…`

| Frame | Shows |
| --- | --- |
| `assistant-home&roster=assistant` | Home with the assistant: Today, the brief, mail, the workspace proposal |
| `…&today=workspaces` / `mail` / `watching` / `needs` | A Today tile opened: goal progress, Important, watches |
| `…&moment=firstrun` | The first minute after setup |
| `focus-workspace&roster=assistant&transcript=asked` | A workspace (API Worker) in the focus layout |
| `explore&roster=assistant` | Explore |
| `explore-workspace&roster=assistant` (`&install=1`) | The Personal assistant's page, and Install |
| `welcome&step=5` | Setup's assistant step |

## 11. Settled since the first draft

- A watch's last finding is a field its turn writes (`triggers.last_finding`), not read back out of the transcript.
- Kinu's blueprints never update an installed workspace: installing makes a workspace of your own, and later versions leave it as it is.

## 12. Not settled

- The assistant's mail send card waits on feat/mail's `mail_send` kind; until it lands the wireframe leaves the reply in Drafts.
