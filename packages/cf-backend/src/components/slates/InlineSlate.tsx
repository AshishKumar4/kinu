import { useCallback, useContext, useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { Loader } from "@/components/ui/Loader";
import { ArrowSquareOutIcon, CaretRightIcon, CheckIcon, PushPinIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import type { SlateCallResult } from "@kinu.run/core";
import {
  buildSlateHostContext, isPreviewUrl, isSlateFrameMessage, PREVIEW_SANDBOX, slateFrameSrc,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT_LIMIT, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema, SLATE_UI_ATTRIBUTE, type SlateHostContext,
} from "@kinu.run/core";
import { useElementSize } from "@/hooks/use-element-size";
import { useTheme } from "@/hooks/use-theme";
import { PreviewChrome } from "@/components/PreviewFrame";
import { SlateInlineContext, SlatePreviews } from "./context";
import { Effect } from "effect";
import { detach, showing } from "@kinu.run/core/obs";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { WorkspacePartHost } from "@/hooks/use-part-host";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { IconControl } from "@/components/ui/IconControl";
import { Pressable } from "@/components/ui/Pressable";
import { Surface } from "@/components/ui/Surface";


/** `sized`: the page reports its own height, as every page kinu:slate serves does; a slate's own server does not. */
/** `broken`: its latest source does not build, and this URL serves the last that did. */
const SlatePreviewSchema = v.strictObject({
  url: v.string(),
  port: v.number(),
  sized: v.boolean(),
  title: v.optional(v.string()),
  broken: v.optional(v.string()),
});

/** Why a slate is not shown, said in the product's words: its own files at fault, or anything else as it came. */
function refusalWords(id: string, refusal: { readonly reason: string; readonly error: string }): string {
  return refusal.reason === 'bad_input' ? `${id} has a build error, and no working version to show yet.` : `${refusal.reason}: ${refusal.error}`;
}

/** Shown over a slate whose latest edit does not build: the version under it is the last that did. */
function BrokenNotice({ title }: { title: string }) {
  return <Notice tone="warning" phrasing data-slate-broken="">{title} has a build error; showing the last working version.</Notice>;
}

const SavedSlateSchema = v.object({ id: v.string(), title: v.string() });

/** Each slate's last height in the chat, so a card drawn again opens at its size and nothing below it moves. */
const KNOWN_HEIGHTS = new Map<string, number>();

/** A frame that never says its height: a slate's own server, or a page that failed before it could. */
const UNSIZED_HEIGHT = 360;

/** How long a loaded page that sizes itself is waited on before it is shown at the height of one that does not. */
const SIZE_WAIT_MS = 4000;

type SlatePreview = v.InferOutput<typeof SlatePreviewSchema>;

/** Read inside effects only: `document` does not exist under the static renderer. */
function readThemeTokens() {
  const styles = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};

  for (const name of SLATE_THEME_TOKENS) {
    const value = styles.getPropertyValue(name).trim();

    if (value !== '') variables[name] = value;
  }

  return variables;
}

const browserOrigin = (): string =>
  'window' in globalThis && window.location !== undefined ? window.location.origin : '';

/**
 * What a slate's page is framed with (`?kinu=`), read off this page now: its theme and tokens, the frame's width, how it
 * is shown, and this page's origin, the one a slate answers to and frames its parts from (`useHostContext().origin`).
 */
export function useSlateHostContext(display: 'inline' | 'pane', width: number): SlateHostContext {
  const theme = useTheme();

  return useMemo(() => buildSlateHostContext({
    theme: theme.mode,
    variables: 'document' in globalThis ? readThemeTokens() : {},
    width,
    display,
    origin: browserOrigin(),
  }), [theme.mode, theme.name, width, display]);
}

/** In the chat, a preview folds behind a later one of its slate, and while the panel shows it. */
export function ChatSlates({ shownInPanel, children }: { shownInPanel: string | null; children: ReactNode }) {
  const inline = useContext(SlateInlineContext);
  const [previews] = useState(() => new SlatePreviews());
  const value = useMemo(() => (inline === null ? null : { ...inline, chat: { previews, shownInPanel } }), [inline, previews, shownInPanel]);

  return <SlateInlineContext.Provider value={value}>{children}</SlateInlineContext.Provider>;
}

const UNLISTED = (): (() => void) => () => {};

/** False until the card's first frame is on screen: a card that mounts folded must not fold in view. */
function usePainted(): boolean {
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setPainted(true)); });

    return () => cancelAnimationFrame(frame);
  }, []);

  return painted;
}

/** An answer's page kept as a slate of the workspace's own, under its title: once kept, the control opens it. */
function SaveControl({ name, save, open }: { name: string; save: () => Promise<SlateCallResult>; open?: (id: string) => void }) {
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const keep = useCallback(() => detach(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
    setBusy(true);
    setFailed(null);
    const result = yield* Effect.promise(save);

    if (result.ok) setSaved(v.parse(SavedSlateSchema, result.value));
    else setFailed(`${result.reason}: ${result.error}`);
  }), showing(setFailed)), Effect.sync(() => { setBusy(false); }))), [save]);

  if (saved !== null) {
    return (
      <IconControl place="inline" data-slate-saved={saved.id} onClick={() => open?.(saved.id)} disabled={open === undefined}
        aria-label={`Saved as ${saved.title}; open it in the work surface`} title={`Saved as ${saved.title}`} className="p-accent-fg">
        <CheckIcon size={11} weight="bold" />
      </IconControl>
    );
  }

  return (
    <IconControl place="inline" data-slate-save onClick={keep} disabled={busy} aria-label={`Save ${name} as a slate`}
      title={failed === null ? "Save as a slate of this workspace" : `Could not save: ${failed}`} className={failed === null ? undefined : "p-danger"}>
      <PushPinIcon size={11} />
    </IconControl>
  );
}

/** No chrome: the frame sits in the answer, and its fold, save and open controls show over it on hover, or always where
 *  there is no hover. Folded, it is one quiet line naming it and why. */
function SlateCard({ id, block, measure, save, children }: {
  id: string;
  block?: string;
  measure: Ref<HTMLSpanElement>;
  /** An answer's page only: a slate with files is the workspace's already. */
  save?: () => Promise<SlateCallResult>;
  children: ReactNode;
}) {
  const inline = useContext(SlateInlineContext);
  const previews = inline?.chat?.previews;
  const [card, setCard] = useState<HTMLSpanElement | null>(null);
  const body = useId();
  const painted = usePainted();

  const register = useCallback((element: HTMLSpanElement | null) => {
    setCard(element);
    const remove = element === null ? undefined : previews?.add(id, element);

    return () => remove?.();
  }, [previews, id]);

  const superseded = useSyncExternalStore(previews?.subscribe ?? UNLISTED, () => previews?.superseded(id, card) ?? false, () => false);
  const inPanel = inline?.chat?.shownInPanel === id;
  const auto = superseded || inPanel;
  // A fold set by hand holds until the reason for the automatic one clears.
  const [hand, setHand] = useState<boolean | null>(null);
  const [reason, setReason] = useState(auto);

  if (reason !== auto) {
    setReason(auto);

    if (!auto) setHand(null);
  }

  const folded = hand ?? auto;
  const openSlate = inline?.openSlate;
  let why: string | null = null;

  if (folded && auto) why = superseded ? "Updated below" : "Shown in the work surface";

  const name = block ?? id;


  const tools = (
    <>
      <Pressable look="compact" onClick={() => setHand(!folded)} aria-expanded={!folded} aria-controls={body} title={folded ? `Show ${name}` : `Fold ${name}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-px">
        <CaretRightIcon size={10} weight="bold" className={`shrink-0 p-text-3 p-fold-turn ${folded ? "" : "rotate-90"}`} />
        {folded && <code className="t-meta t-mono p-text-3 truncate">{name}</code>}
        {why !== null && <span className="t-meta ml-auto shrink-0 pl-2 p-text-3">{why}</span>}
      </Pressable>
      {save !== undefined && <SaveControl name={name} save={save} open={openSlate} />}
      {openSlate !== undefined && (
        <Button variant="ghost" size="sm" icon={<ArrowSquareOutIcon size={14} />} className="shrink-0" onClick={() => openSlate(id)} aria-label={`Open ${name} in the work surface`} title="Open in the work surface" />
      )}
    </>
  );

  // Spans only: the card renders inside a markdown <p>, where a <div> trips React's dev validator.
  return (
    <span ref={measure} data-slate-inline={id} {...(block === undefined ? {} : { [SLATE_UI_ATTRIBUTE]: block })}
      data-fold-still={painted ? undefined : ""} className="group/slate relative block my-2">
      {folded
        ? <span ref={register} className="flex items-center gap-1 py-px">{tools}</span>
        : (
          <Surface as="span" look="tile" ref={register}
            className="absolute right-1 top-1 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/slate:opacity-100 group-focus-within/slate:opacity-100 [@media(hover:none)]:opacity-100">
            {tools}
          </Surface>
        )}
      <span id={body} className="p-fold" data-folded={folded ? "" : undefined} inert={folded}>
        <span><span className="block">{children}</span></span>
      </span>
    </span>
  );
}

/** The frame's style, whether its page has yet to say its height, and the height it last had. */
interface InlineHeight {
  readonly style: CSSProperties | undefined;
  readonly waiting: boolean;
  readonly known: number | undefined;
}

/**
 * An in-chat frame's height: what its page last said, kept for the slate across redraws. A page that sizes itself is
 * hidden until it has said, then drawn at that height with nothing inside it to scroll; one that stays silent past a
 * bounded wait, or never sizes itself, is drawn at a fixed height.
 */
function useInlineHeight({ id, inline, sized, frame, previewOrigin, loaded, drawn }: {
  id: string;
  inline: boolean;
  sized: boolean;
  frame: RefObject<HTMLIFrameElement | null>;
  previewOrigin: string | null;
  loaded: boolean;
  /** What a new drawing of the frame is keyed by: its height is heard again. */
  drawn: string | null;
}): InlineHeight {
  // How many heights the page has said: the first is drawn at once, and each later one eases in.
  const [said, setSaid] = useState<{ readonly height: number | null; readonly times: number }>({ height: null, times: 0 });
  const [late, setLate] = useState(false);
  const known = KNOWN_HEIGHTS.get(id);
  const { height } = said;
  const waiting = inline && sized && height === null && !late;

  useEffect(() => {
    setSaid({ height: null, times: 0 });
    setLate(false);
  }, [drawn]);

  useEffect(() => {
    if (!inline || previewOrigin === null) return;

    const onMessage = (event: MessageEvent): void => {
      if (!isSlateFrameMessage(event, frame.current?.contentWindow ?? null, previewOrigin)) return;
      const next = Math.min(v.parse(SlateFrameMessageSchema, event.data).height, SLATE_INLINE_HEIGHT_LIMIT);
      KNOWN_HEIGHTS.set(id, next);
      setSaid((was) => (was.height === next ? was : { height: next, times: was.times + 1 }));
    };

    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, [inline, previewOrigin, id, frame]);

  useEffect(() => {
    if (!waiting || !loaded) return;
    const timer = setTimeout(() => { setLate(true); }, SIZE_WAIT_MS);

    return () => { clearTimeout(timer); };
  }, [waiting, loaded]);

  if (!inline) return { style: undefined, waiting, known };

  if (waiting) return { style: { height: 0, visibility: 'hidden' }, waiting, known };

  return { style: { height: height ?? known ?? UNSIZED_HEIGHT, ...(said.times <= 1 && { transition: 'none' }) }, waiting, known };
}

export function InlineSlate({ id, block, rpc, display, reloadKey = 0, onReady }: {
  id: string;
  /** The `<slate-ui>` block's name when the slate is an answer's own. */
  block?: string;
  rpc: WorkspaceRpc;
  display: 'inline' | 'pane';
  reloadKey?: number;
  onReady?: () => void;
}) {
  const { attach, size } = useElementSize();
  const [preview, setPreview] = useState<SlatePreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // The iframe src snapshots this once via `contextRef`; later values go over postMessage.
  const context = useSlateHostContext(display, size.w);

  const contextRef = useRef(context);
  contextRef.current = context;

  const notifyReady = useEffectEvent(() => onReady?.());

  useEffect(() => {
    let live = true;
    setPreview(null);
    setRefusal(null);

    detach(Effect.catchCause(Effect.map(Effect.promise(() => rpc("previewSlate", [id])), (result) => {
      if (!live) return;

      if (!result.ok) {
        setRefusal(refusalWords(id, result));

        return;
      }

      const parsed = v.safeParse(SlatePreviewSchema, result.value);

      if (!parsed.success) {
        setRefusal(`The Slate "${id}" answered an invalid preview URL.`);

        return;
      }

      setPreview(parsed.output);
      notifyReady();
    }), showing((chain) => { if (live) setRefusal(chain); })));

    return () => { live = false; };
  }, [id, rpc, display, reloadKey]);

  const previewOrigin = useMemo(() => (preview === null ? null : new URL(preview.url).origin), [preview]);
  // The src is a snapshot; recomputing it on a theme flip would reload the slate.

  const src = useMemo(
    () => (preview === null ? null : slateFrameSrc(preview.url, contextRef.current)),
    [preview],
  );

  // Post only after the frame's `load`: before it the target is about:blank and the browser throws.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [src]);

  useEffect(() => {
    const window_ = frame.current?.contentWindow;

    if (previewOrigin === null || window_ == null || !loaded) return;
    window_.postMessage({ kinu: SLATE_HOST_CONTEXT_MESSAGE, context }, previewOrigin);
  }, [context, previewOrigin, loaded]);

  const pane = display === 'pane';
  const previewUrl = preview?.url;
  const { style: frameStyle, waiting, known } = useInlineHeight({ id, inline: !pane, sized: preview?.sized === true, frame, previewOrigin, loaded, drawn: src });
  const save = useMemo(() => (block === undefined ? undefined : async () => rpc("slate", [{ op: 'save', page: id }])), [block, rpc, id]);

  const notice = preview?.broken === undefined ? null : <BrokenNotice title={preview.title ?? id} />;
  // The owner's own preview runs its personal parts as the owner, one host to a preview.
  const decision = <WorkspacePartHost slate={id} titled={preview} slateFrame={frame} />;
  let content: ReactNode = null;

  if (src !== null) {
    // The only gate on what this frame renders, same as PreviewFrame's.
    content = isPreviewUrl(previewUrl ?? '') ? (
      <iframe
        ref={frame}
        src={src}
        title={id}
        onLoad={() => setLoaded(true)}
        className="p-slate-frame"
        data-pane={pane ? '' : undefined}
        style={frameStyle}
        sandbox={PREVIEW_SANDBOX}
      />
    ) : (
      <div className="flex-1 flex items-center justify-center p-4 text-center">
        <span className="t-meta t-mono p-text-3 break-all">
          Refused to preview a URL that is not a Kinu preview: {previewUrl}
        </span>
      </div>
    );
  }

  // In the column, the page sits inset on the column's ground as a card of its own, its address above it.
  if (pane) {
    return (
      <div className="p-pane gap-2">
        {notice}
        {decision}
        {refusal !== null && (
          <Notice tone="danger"><p className="break-words">{refusal}</p></Notice>
        )}
        {content === null && refusal === null && (
          <div className="flex justify-center py-16"><Loader /></div>
        )}
        {content !== null && src !== null && (
          <div key={reloadKey} className="p-pane-card">
            <PreviewChrome url={previewUrl ?? src} />
            {content}
          </div>
        )}
      </div>
    );
  }

  return (
    <SlateCard id={id} block={block} measure={attach} save={save}>
      {notice}
      {decision}
      {refusal !== null && (
        <Notice tone="danger" phrasing><span className="block break-words">{refusal}</span></Notice>
      )}
      {(content === null || waiting) && refusal === null && (
        <span className={`flex items-center justify-center ${known === undefined ? "py-8" : ""}`} style={known === undefined ? undefined : { height: known }}><Loader /></span>
      )}
      {content}
    </SlateCard>
  );
}
