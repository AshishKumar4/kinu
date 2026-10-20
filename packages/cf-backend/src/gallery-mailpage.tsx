/** The production Mail page, reading and writing the HTTP fixture made from the approved wireframe's mail. */
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import type { MailBox, MailListing, MailMessageView, MailThreadSummary, MailThreadView, MailView } from "@kinu.run/core";
import Layout from "@/components/layout";
import MailPage from "@/pages/MailPage";
import { ADDRESSES, OWNER, THREADS } from "@/gallery-mail";
import type { Important, MailBoxes } from "@/lib/mail-api";

const OutgoingSchema = v.object({
  path: v.string(), to: v.array(v.string()), cc: v.optional(v.array(v.string())), subject: v.string(), text: v.string(),
  threadId: v.optional(v.string()), inReplyTo: v.optional(v.nullable(v.string())),
});

type Outgoing = v.InferOutput<typeof OutgoingSchema>;

function installFixture(): void {
  const params = new URLSearchParams(location.search);
  const next = window.fetch.bind(window);
  const assistant = params.get("assistant") !== "none";
  const email = params.get("account") === "claim" ? OWNER.address.toUpperCase() : OWNER.address;
  let address: string | null = params.has("account") ? null : "ashish@kinu.run";

  const boxes: MailBox[] = ADDRESSES.map((box) => {
    let kind: MailBox["kind"] = "workspace";

    if (box.id === "ashish") kind = "person";

    if (box.id === "scout") kind = "agent";

    return {
      path: box.id === "ashish" ? "" : box.address.split("@")[0].split(".").slice(0, -1).join("."), address: box.address, kind,
      workspace: box.id === "ashish" && !assistant ? null : box.workspace, actorId: box.agent, wake: "owner",
    };
  });

  const boxFor = (id: string): MailBox => boxes[ADDRESSES.findIndex((box) => box.id === id)];

  const threads = new Map<string, MailThreadView>(THREADS.map((thread) => {
    const box = boxFor(thread.box);

    const messages: MailMessageView[] = thread.mail.map((mail) => ({
      id: mail.id, threadId: thread.id, direction: mail.sent === undefined ? "in" : "out", from: mail.from,
      to: mail.to.map((recipient) => ({ name: null, address: recipient })), cc: [], deliveredTo: box.address,
      subject: thread.subject, at: mail.at, verified: mail.verified, auth: mail.auth, woke: mail.woke?.as ?? null,
      text: mail.text, html: mail.html ?? null, attachments: (mail.attachments ?? []).map((file, index) => ({
        id: `${mail.id}-${String(index)}`, filename: file.name, size: Number.parseInt(file.size) * 1024,
        contentType: file.name.endsWith(".pdf") ? "application/pdf" : "application/zip",
      })), writtenBy: mail.sent?.by === "you" ? null : mail.sent?.by ?? null, sendState: mail.sent === undefined ? null : "sent", read: !thread.unread,
    }));

    const latest = messages.at(-1) ?? messages[0];

    if (thread.draft !== undefined) messages.push({
      ...latest, id: `${thread.id}-draft`, direction: "out", from: { name: null, address: box.address },
      to: [messages.find((mail) => mail.direction === "in")?.from ?? latest.from], text: thread.draft.text,
      writtenBy: thread.draft.by === "you" ? null : "Kinu", sendState: "draft", html: null, attachments: [], woke: null,
    });

    return [thread.id, { thread: {
      id: thread.id, path: box.path, subject: thread.subject, from: [...new Map(messages.map((mail) => [mail.from.address, mail.from])).values()],
      snippet: latest.text, at: latest.at, count: thread.mail.length, unread: thread.unread, verified: latest.verified,
      attachments: messages.some((mail) => mail.attachments.length > 0), important: assistant ? thread.important ?? null : null,
      trashedAt: thread.trashed ?? null, draft: thread.draft !== undefined, outgoing: thread.mail.some((mail) => mail.sent !== undefined),
    }, messages }];
  }));

  const calls: { method: string; path: string; body: unknown }[] = [];
  let written = 0;

  const list = (url: URL): MailListing => {
    const view = url.searchParams.get("view") ?? "all";
    const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

    const shown = [...threads.values()].filter(({ thread, messages }) => {
      if (view === "trash" ? thread.trashedAt === null : thread.trashedAt !== null) return false;

      if (view === "important" && thread.important === null) return false;

      if (view === "sent" && !thread.outgoing) return false;

      if (view === "drafts" && !thread.draft) return false;

      if (url.searchParams.has("path") && thread.path !== url.searchParams.get("path")) return false;

      if (url.searchParams.has("before") && thread.at >= Number(url.searchParams.get("before"))) return false;
      const text = [thread.subject, ...messages.flatMap((mail) => [mail.from.name, mail.from.address, mail.text])].join(" ").toLowerCase();

      return words.every((word) => text.includes(word));
    }).map(({ thread }) => thread).sort((a, b) => b.at - a.at);

    return { threads: shown.slice(0, 50), unread: shown.filter((thread) => thread.unread).length };
  };

  const answer = (value: MailBoxes | MailListing | MailThreadView | MailThreadSummary | MailMessageView | Important | { address: string }): Promise<Response> => Promise.resolve(Response.json(value));

  const write = (outgoing: Outgoing, draft: boolean): Promise<Response> => {
    const id = `written-${String(++written)}`;
    const threadId = outgoing.threadId ?? id;
    const held = threads.get(threadId);
    const box = boxes.find((each) => each.path === outgoing.path);

    if (box === undefined) return Promise.resolve(Response.json({ error: "No such box." }, { status: 404 }));

    const message: MailMessageView = {
      id, threadId, direction: "out", from: { name: null, address: box.address },
      to: outgoing.to.map((to) => ({ name: null, address: to })), cc: (outgoing.cc ?? []).map((cc) => ({ name: null, address: cc })),
      deliveredTo: null, subject: outgoing.subject, at: Date.now(), verified: true, auth: null, woke: null,
      text: outgoing.text, html: null, attachments: [], writtenBy: null, sendState: draft ? "draft" : "sent", read: true,
    };

    const summary: MailThreadSummary = {
      id: threadId, path: box.path, subject: outgoing.subject, from: [message.from], snippet: message.text,
      at: message.at, count: 1, unread: false, verified: true, attachments: false, important: null, trashedAt: null, draft, outgoing: !draft,
    };

    const messages = [...(held?.messages ?? []).filter((mail) => mail.sendState !== "draft"), message];
    threads.set(threadId, { thread: { ...held?.thread ?? summary, draft, outgoing: !draft || held?.thread.outgoing === true, count: messages.length, snippet: message.text, at: message.at }, messages });

    return answer(message);
  };

  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), location.href), init);
    const url = new URL(request.url);

    if (url.pathname === "/api/user/profile") return Promise.resolve(Response.json({
      email, displayName: OWNER.name, createdAt: Date.now(), lastSeenAt: Date.now(), onboardedAt: Date.now(), workspaceCount: 2, controlPlane: false,
    }));

    if (!url.pathname.startsWith("/api/user/mail/")) return next(input, init);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
    document.documentElement.dataset.mailCalls = JSON.stringify(calls);

    const fail = params.get("fail");

    if (fail === "thread" && url.pathname.startsWith("/api/user/mail/threads/") || fail === "send" && url.pathname.endsWith("/send")) {
      return Promise.resolve(Response.json({ error: "The mail server refused this request." }, { status: 503 }));
    }

    if (url.pathname.endsWith("/boxes")) return answer({ address, canClaim: address === null && params.get("account") === "claim", boxes: address === null ? [] : boxes });

    if (url.pathname.endsWith("/claim")) {
      address = `${v.parse(v.object({ username: v.string() }), body).username}@kinu.run`;
      boxes[0] = { ...boxes[0], address };

      return answer({ address });
    }

    if (url.pathname.endsWith("/threads")) return answer(list(url));

    if (url.pathname.endsWith("/important")) {
      const listing = list(new URL("/api/user/mail/threads?view=important", location.href));

      return answer({ unread: listing.unread, items: listing.threads.slice(0, Number(url.searchParams.get("limit") ?? 3)).map((thread) => ({
        thread: thread.id, from: { name: thread.from[0]?.name ?? thread.from[0]?.address ?? "", address: thread.from[0]?.address ?? "" }, to: boxes.find((box) => box.path === thread.path)?.address ?? "", subject: thread.subject,
        reason: thread.important ?? "", at: thread.at, unread: thread.unread,
      })) });
    }

    if (url.pathname.endsWith("/send") || url.pathname.endsWith("/drafts")) {
      return write(v.parse(OutgoingSchema, body), url.pathname.endsWith("/drafts"));
    }

    const id = decodeURIComponent(url.pathname.slice("/api/user/mail/threads/".length));
    const held = threads.get(id);

    if (held === undefined) return Promise.resolve(Response.json({ error: "No such thread." }, { status: 404 }));

    if (request.method === "PATCH") {
      const change = v.parse(v.object({ read: v.optional(v.boolean()), trashed: v.optional(v.boolean()) }), body);
      let trashedAt = held.thread.trashedAt;

      if (change.trashed !== undefined) trashedAt = change.trashed ? Date.now() : null;

      const updated = {
        ...held, thread: { ...held.thread, unread: change.read === undefined ? held.thread.unread : !change.read, trashedAt },
        messages: change.read === undefined ? held.messages : held.messages.map((mail) => ({ ...mail, read: change.read ?? mail.read })),
      };

      threads.set(id, updated);

      return answer(updated.thread);
    }

    return answer(held);
  }, { preconnect: next.preconnect });
}

export default function mailPageFrame() {
  installFixture();
  const params = new URLSearchParams(location.search);
  const views: readonly MailView[] = ["important", "all", "sent", "drafts", "trash"];
  const view = views.find((name) => name === params.get("view")) ?? "important";
  const thread = params.get("thread");

  return {
    entries: [`/mail${thread === null ? "" : `/${encodeURIComponent(thread)}`}?view=${view}`],
    node: <Routes><Route element={<Layout />}><Route path="/mail/*" element={<MailPage />} /></Route></Routes>,
  };
}
