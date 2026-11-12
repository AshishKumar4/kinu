import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as v from "valibot";
import { detachPromise } from "@kinu.run/core/obs";
import type { FileUIPart } from "ai";
import { agentRoute } from "@kinu.run/core";
import { uploadOfPart } from "@/lib/attachments-api";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { PromptCard } from "./PromptCard";
import { usePastedSecretGuard } from "@/components/secrets/PasteOffer";

/** A sent file as a part carries it: named by its upload (`kinu.upload`), which the opening's send names. */
const FilePartSchema = v.object({
  type: v.literal("file"), mediaType: v.string(), url: v.string(), filename: v.optional(v.string()),
  providerMetadata: v.optional(v.object({ kinu: v.object({ upload: v.string() }) })),
});

/** Files chosen where there was no workspace yet (Home): carried as they are, to upload into the one just made. */
const CarriedAttachmentsSchema = v.strictObject({ attachments: v.array(v.instance(File)) });

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
    detachPromise(async () => {
      await navigate(location.pathname, { replace: true, state: null });
      take(parsed.output);
    });
  }, [schema, ready, state, take, navigate, location.pathname]);
}

export function useCarriedAttachments(add: (files: readonly File[]) => void): void {
  useCarried(CarriedAttachmentsSchema, true, ({ attachments }) => add(attachments));
}

/** Carried from the new-chat view to the chat it opened. */
/** A sent file as the opening carries it: each field the schema keeps, its upload named. */
function carriedPart(part: FileUIPart): v.InferInput<typeof FilePartSchema> {
  const upload = uploadOfPart(part);

  return {
    type: "file", mediaType: part.mediaType, url: part.url,
    ...(part.filename !== undefined && { filename: part.filename }), ...(upload !== null && { providerMetadata: { kinu: { upload } } }),
  };
}

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
  // The workspace is there: each file uploads to it as it is added, and the opening names them once they have landed.
  const files = usePendingAttachments(workspace);
  const [text, setText] = useState("");
  const { busy, error, run } = useLabelledStep();

  const start = (): void => {
    const opening = text.trim();

    if ((opening === "" && files.parts.length === 0) || files.uploading) return;
    run("start", async () => {
      const created = await createChat(opening);
      const state: Opening = { opening, attachments: files.parts.map(carriedPart) };

      await navigate(agentRoute(workspace, created.name), { state });
    });
  };

  // The opening is the chat's first message: a pasted secret is offered to Secrets before the chat is made with it.
  const secretGuard = usePastedSecretGuard({ draft: text, setDraft: setText, workspace });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-new-chat>
      <div className="mx-auto flex min-h-full w-full max-w-[var(--layout-new-chat)] flex-col justify-center gap-8 px-6 py-[var(--layout-new-chat-pad)]">
        <h1 className="t-page-title t-hero-chat text-center p-text">
          What do you want to work on in <span className="p-accent-fg">{title}</span>?
        </h1>
        <PromptCard id="new-chat-opening" label="New chat" placeholder="Ask a question, plan a change, or hand over a task…"
          action="Start chat" value={text} onChange={setText} onSubmit={secretGuard.guarded("start", start)} notice={secretGuard.offer}
          busy={busy !== null || files.uploading} error={error ?? files.refusal}
          attachments={{ items: files.items, onAdd: files.add, onRemove: files.remove }} />
      </div>
    </div>
  );
}

/** Sends the new-chat view's message once this chat's socket is up, then drops it from history so a reload never resends. */
export function useOpeningMessage(ready: boolean, send: (text: string, files: readonly FileUIPart[]) => void): void {
  useCarried(OpeningSchema, ready, ({ opening, attachments }) => send(opening, attachments));
}
