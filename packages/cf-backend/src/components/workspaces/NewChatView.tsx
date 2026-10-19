import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as v from "valibot";
import { detach, showing } from "@kinu.run/core/obs";
import type { FileUIPart } from "ai";
import { CLOUD_MAX_INLINE_ATTACHMENT_BYTES } from "@kinu.run/core";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { PromptCard } from "./PromptCard";

const FilePartSchema = v.object({ type: v.literal("file"), mediaType: v.string(), url: v.string(), filename: v.optional(v.string()) });

const CarriedAttachmentsSchema = v.strictObject({ attachments: v.array(FilePartSchema) });

/** What a navigation carried here, taken once `ready`, then dropped from history so a reload never takes it again. */
function useCarried<S extends v.GenericSchema>(schema: S, ready: boolean, take: (carried: v.InferOutput<S>) => void): void {
  const location = useLocation();
  const navigate = useNavigate();
  const state: unknown = location.state;
  const taken = useRef<unknown>(null);

  // Once per state carried: keyed on a parse, which is new each render, files were offered again every render until
  // the page crashed.
  useEffect(() => {
    const parsed = v.safeParse(schema, state);

    if (!ready || !parsed.success || taken.current === state) return;
    taken.current = state;
    detach(Effect.promise(async () => {
      await navigate(location.pathname, { replace: true, state: null });
      take(parsed.output);
    }));
  }, [schema, ready, state, take, navigate, location.pathname]);
}

export function useCarriedAttachments(offer: (parts: readonly FileUIPart[]) => void): void {
  useCarried(CarriedAttachmentsSchema, true, ({ attachments }) => offer(attachments));
}

/** Carried from the new-chat view to the chat it opened. */
const OpeningSchema = v.object({ opening: v.string(), attachments: v.optional(v.array(FilePartSchema), []) });

type Opening = v.InferInput<typeof OpeningSchema>;

/** The landing's question, asked of this workspace: the first message opens a chat of its own. */
export function NewChatView({ workspace, title, createChat }: {
  workspace: string;
  title: string;
  /** `opening` names the chat; it is sent once the chat exists. */
  createChat: (opening: string) => Promise<{ name: string }>;
}) {
  const navigate = useNavigate();
  const files = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(() => detach(Effect.gen(function* () {
    const opening = text.trim();

    if (opening === "" && files.parts.length === 0) return;
    setBusy(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const created = yield* Effect.promise(async () => createChat(opening));
      const state: Opening = { opening, attachments: [...files.parts] };
      yield* Effect.promise(async () => navigate(`/workspace/${workspace}/agents/${encodeURIComponent(created.name)}`, { state }));
    }), showing(setError)), Effect.sync(() => setBusy(false)));
  })), [text, files.parts, createChat, navigate, workspace]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-new-chat>
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center gap-7 px-6 py-[clamp(48px,12vh,120px)]">
        <h1 className="p-display text-center text-[clamp(28px,3.4vw,40px)] font-semibold leading-[1.15] p-text">
          What do you want to work on in <span className="p-accent">{title}</span>?
        </h1>
        <PromptCard id="new-chat-opening" label="New chat" placeholder="Ask a question, plan a change, or hand over a task…"
          action="Start chat" value={text} onChange={setText} onSubmit={start} busy={busy} error={error ?? files.refusal}
          attachments={{ parts: files.parts, onAdd: files.add, onRemove: files.remove }} />
      </div>
    </div>
  );
}

/** Sends the new-chat view's message once this chat's socket is up, then drops it from history so a reload never resends. */
export function useOpeningMessage(ready: boolean, send: (text: string, files: readonly FileUIPart[]) => void): void {
  useCarried(OpeningSchema, ready, ({ opening, attachments }) => send(opening, attachments));
}
