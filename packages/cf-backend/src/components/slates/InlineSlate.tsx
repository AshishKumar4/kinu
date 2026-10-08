import { useCallback, useContext, useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { ArrowSquareOutIcon, CaretRightIcon, CheckIcon, PushPinIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import type { Rpc, SlateCallResult } from "@kinu.run/core";
import {
  buildSlateHostContext, isPreviewUrl, isSlateFrameMessage, PREVIEW_SANDBOX, slateFrameSrc,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT_LIMIT, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema, SLATE_UI_ATTRIBUTE,
} from "@kinu.run/core";
import { useElementSize } from "@/hooks/use-element-size";
import { useTheme } from "@/hooks/use-theme";
import { PreviewChrome } from "@/components/PreviewFrame";
import { SlateInlineContext, SlatePreviews } from "./context";
import { Effect } from "effect";
import { detach, showing } from "@kinu.run/core/obs";


/** `sized`: the page reports its own height, as every page kinu:slate serves does; a slate's own server does not. */
const SlatePreviewSchema = v.strictObject({
  url: v.string(),
  port: v.number(),
  sized: v.boolean(),
});

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

const FONT_URL = /url\((["']?)([^"')]+)\1\)/g;

/** The app's `@font-face` rules, their sources made absolute, so the frame sets its text in the chat's own faces. Read
 *  inside effects only, and only from this origin's sheets: another origin's rules cannot be read. */
function readFontFaces(): string {
  const faces: string[] = [];

  for (const sheet of document.styleSheets) {
    if (sheet.href !== null && new URL(sheet.href).origin !== window.location.origin) continue;
    const base = sheet.href ?? window.location.href;

    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSFontFaceRule) faces.push(rule.cssText.replace(FONT_URL, (_whole, quote: string, path: string) => `url(${quote}${new URL(path, base).href}${quote})`));
    }
  }

  return faces.join("\n");
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
function SaveControl({ name, save, open }: { name: string; save: () => Promise<{ id: string; title: string }>; open?: (id: string) => void }) {
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const control = "p-text-3 hover:p-text p-1 shrink-0 inline-flex rounded-md transition-colors hover:bg-[var(--c-elevated)]";

  if (saved !== null) {
    return (
      <button type="button" data-slate-saved={saved.id} onClick={() => open?.(saved.id)} disabled={open === undefined}
        aria-label={`Saved as ${saved.title}; open it in the work surface`} title={`Saved as ${saved.title}`} className={`${control} p-accent`}>
        <CheckIcon size={11} weight="bold" />
      </button>
    );
  }

  const keep = (): void => {
    setBusy(true);
    setFailed(null);
    detach(Effect.ensuring(Effect.catchCause(Effect.map(Effect.promise(save), setSaved), showing(setFailed)), Effect.sync(() => { setBusy(false); })));
  };

  return (
    <button type="button" data-slate-save onClick={keep} disabled={busy} aria-label={`Save ${name} as a slate`}
      title={failed === null ? "Save as a slate of this workspace" : `Could not save: ${failed}`} className={`${control} ${failed === null ? "" : "p-danger"}`}>
      <PushPinIcon size={11} />
    </button>
  );
}

/** No chrome: the frame sits in the answer, and its fold, save and open controls show over it on hover, or always where
 *  there is no hover. Folded, it is one quiet line naming it and why. */
function SlateCard({ id, block, measure, save, children }: {
  id: string;
  block?: string;
  measure: Ref<HTMLSpanElement>;
  /** An answer's page only: a slate with files is the workspace's already. */
  save?: () => Promise<{ id: string; title: string }>;
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

  const controls = folded
    ? "flex items-center gap-1 py-0.5"
    : "absolute right-1 top-1 z-10 flex items-center gap-1 rounded-md p-elevated opacity-0 transition-opacity group-hover/slate:opacity-100 group-focus-within/slate:opacity-100 [@media(hover:none)]:opacity-100";

  // Spans only: the card renders inside a markdown <p>, where a <div> trips React's dev validator.
  return (
    <span ref={measure} data-slate-inline={id} {...(block === undefined ? {} : { [SLATE_UI_ATTRIBUTE]: block })}
      data-fold-still={painted ? undefined : ""} className="group/slate relative block my-2">
      <span ref={register} className={controls}>
        <button type="button" onClick={() => setHand(!folded)} aria-expanded={!folded} aria-controls={body} title={folded ? `Show ${name}` : `Fold ${name}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--c-elevated)]">
          <CaretRightIcon size={10} weight="bold" className={`shrink-0 p-text-4 p-fold-turn ${folded ? "" : "rotate-90"}`} />
          {folded && <code className="p-annotation p-text-3 truncate">{name}</code>}
          {why !== null && <span className="ml-auto shrink-0 pl-2 p-meta p-text-4">{why}</span>}
        </button>
        {save !== undefined && <SaveControl name={name} save={save} open={openSlate} />}
        {openSlate !== undefined && (
          <button type="button" onClick={() => openSlate(id)} aria-label={`Open ${name} in the work surface`} title="Open in the work surface"
            className="p-text-3 hover:p-text p-1 shrink-0 inline-flex rounded-md transition-colors hover:bg-[var(--c-elevated)]">
            <ArrowSquareOutIcon size={11} />
          </button>
        )}
      </span>
      <span id={body} className="p-fold" data-folded={folded ? "" : undefined} inert={folded}>
        <span><span className="block">{children}</span></span>
      </span>
    </span>
  );
}

export function InlineSlate({ id, block, rpc, display, reloadKey = 0, onReady }: {
  id: string;
  /** The `<slate-ui>` block's name when the slate is an answer's own. */
  block?: string;
  rpc: Rpc;
  display: 'inline' | 'pane';
  reloadKey?: number;
  onReady?: () => void;
}) {
  const theme = useTheme();
  const { attach, size } = useElementSize();
  const [preview, setPreview] = useState<SlatePreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // What the page says it is, this mount; until then the card holds the height it last had, or a loader.
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // The iframe src snapshots this once via `contextRef`; later values go over postMessage.
  const context = useMemo(() => buildSlateHostContext({
    theme: theme.mode,
    variables: 'document' in globalThis ? readThemeTokens() : {},
    fonts: 'document' in globalThis ? readFontFaces() : '',
    width: size.w,
    display,
    origin: browserOrigin(),
  }), [theme.mode, size.w, display]);

  const contextRef = useRef(context);
  contextRef.current = context;

  const notifyReady = useEffectEvent(() => onReady?.());

  useEffect(() => {
    let live = true;
    setPreview(null);
    setRefusal(null);
    setHeight(null);

    detach(Effect.catchCause(Effect.map(Effect.promise(() => rpc<SlateCallResult>("previewSlate", [id])), (result) => {
      if (!live) return;

      if (!result.ok) {
        setRefusal(`${result.reason}: ${result.error}`);

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

  useEffect(() => {
    if (display !== 'inline' || previewOrigin === null) return;

    const onMessage = (event: MessageEvent): void => {
      if (!isSlateFrameMessage(event, frame.current?.contentWindow ?? null, previewOrigin)) return;
      const next = Math.min(v.parse(SlateFrameMessageSchema, event.data).height, SLATE_INLINE_HEIGHT_LIMIT);
      KNOWN_HEIGHTS.set(id, next);
      setHeight(next);
    };

    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, [display, previewOrigin, id]);

  const pane = display === 'pane';
  const previewUrl = preview?.url;
  const known = KNOWN_HEIGHTS.get(id);
  const [late, setLate] = useState(false);
  // A page that sizes itself is drawn once it has: at its height, with nothing inside it to scroll.
  const waiting = !pane && preview?.sized === true && height === null && !late;

  useEffect(() => {
    if (!waiting || !loaded) return;
    const timer = setTimeout(() => { setLate(true); }, SIZE_WAIT_MS);

    return () => { clearTimeout(timer); };
  }, [waiting, loaded]);
  let frameStyle: CSSProperties | undefined;

  if (!pane) frameStyle = waiting ? { height: 0, visibility: 'hidden' } : { height: height ?? known ?? UNSIZED_HEIGHT };

  const save = useMemo(() => (block === undefined ? undefined : async () => {
    const result = await rpc<SlateCallResult>("slate", [{ op: 'save', page: id }]);

    if (!result.ok) throw new Error(`${result.reason}: ${result.error}`);

    return v.parse(SavedSlateSchema, result.value);
  }), [block, rpc, id]);

  let content: ReactNode = null;

  if (src !== null) {
    // The only gate on what this frame renders, same as PreviewFrame's.
    content = isPreviewUrl(previewUrl ?? '') ? (
      <iframe
        ref={frame}
        src={src}
        title={id}
        onLoad={() => setLoaded(true)}
        className={pane ? 'p-bg flex-1 min-h-0 w-full border-0' : 'block w-full border-0 rounded-xl p-fold-frame'}
        style={frameStyle}
        sandbox={PREVIEW_SANDBOX}
      />
    ) : (
      <div className="flex-1 flex items-center justify-center p-4 text-center">
        <span className="p-annotation p-text-3 break-all">
          Refused to preview a URL that is not a Kinu preview: {previewUrl}
        </span>
      </div>
    );
  }

  if (pane) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {refusal !== null && (
          <div className="p-notice-danger rounded-lg px-3 py-2 text-xs">
            <p className="break-words m-0">{refusal}</p>
          </div>
        )}
        {content === null && refusal === null && (
          <div className="flex justify-center py-16"><Loader /></div>
        )}
        {content !== null && src !== null && (
          <div key={reloadKey} className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <PreviewChrome url={previewUrl ?? src} />
            {content}
          </div>
        )}
      </div>
    );
  }

  return (
    <SlateCard id={id} block={block} measure={attach} save={save}>
      {refusal !== null && (
        <span className="block p-notice-danger px-3 py-2 text-xs">
          <span className="block break-words m-0">{refusal}</span>
        </span>
      )}
      {(content === null || waiting) && refusal === null && (
        <span className={`flex items-center justify-center ${known === undefined ? "py-8" : ""}`} style={known === undefined ? undefined : { height: known }}><Loader /></span>
      )}
      {content}
    </SlateCard>
  );
}
