import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as v from "valibot";
import { detach, showing } from "@kinu.run/core/obs";
import { PromptCard } from "./PromptCard";

/** Carried in the router's state from the new-chat view to the chat it opened. */
const OpeningSchema = v.object({ opening: v.string() });

type Opening = v.InferOutput<typeof OpeningSchema>;

/** The landing's question, asked of this workspace: the first message opens a chat of its own. */
export function NewChatView({ workspace, title, createChat }: {
  workspace: string;
  title: string;
  createChat: () => Promise<{ name: string }>;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(() => detach(Effect.gen(function* () {
    const opening = text.trim();

    if (opening === "") return;
    setBusy(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const created = yield* Effect.promise(createChat);
      const state: Opening = { opening };
      yield* Effect.promise(async () => navigate(`/workspace/${workspace}/agents/${encodeURIComponent(created.name)}`, { state }));
    }), showing(setError)), Effect.sync(() => setBusy(false)));
  })), [text, createChat, navigate, workspace]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-new-chat>
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center gap-7 px-6 py-[clamp(48px,12vh,120px)]">
        <h1 className="p-display text-center text-[clamp(28px,3.4vw,40px)] font-semibold leading-[1.15] p-text">
          What do you want to work on in <span className="p-accent">{title}</span>?
        </h1>
        <PromptCard id="new-chat-opening" label="New chat" placeholder="Ask a question, plan a change, or hand over a task…"
          action="Start chat" value={text} onChange={setText} onSubmit={start} busy={busy} error={error} />
      </div>
    </div>
  );
}

/** Sends the new-chat view's message once this chat's socket is up, then drops it from history so a reload never resends. */
export function useOpeningMessage(ready: boolean, send: (text: string) => void): void {
  const location = useLocation();
  const navigate = useNavigate();
  const parsed = v.safeParse(OpeningSchema, location.state);
  const opening = parsed.success ? parsed.output.opening : null;
  const sent = useRef(false);

  useEffect(() => {
    if (!ready || opening === null || sent.current) return;
    sent.current = true;
    detach(Effect.promise(async () => {
      await navigate(location.pathname, { replace: true, state: null });
      send(opening);
    }));
  }, [ready, opening, send, navigate, location.pathname]);
}
