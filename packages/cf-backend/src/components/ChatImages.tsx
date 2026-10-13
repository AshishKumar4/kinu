/**
 * Pictures in the thread: an image a tool made, under its row, and an image the answer names, after the words that name
 * it, read through the workspace's own file route. A web address loads only when the owner asks, since loading it tells
 * that site the answer was read. A click opens the picture whole, the message's others a step away.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftIcon, ArrowRightIcon, DownloadSimpleIcon, FolderSimpleIcon, GlobeIcon, ImageBrokenIcon, LaptopIcon, TerminalWindowIcon,
  XIcon, type Icon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { drawnText, namedImages, type ImageMachine, type NamedImage } from "@kinu.run/core";

/** Where the chat reads a workspace file's bytes, and where Files shows it. Absent, the chat names pictures only. */
export interface ChatImageSource {
  /** The file route for an absolute path in the workspace's file plane; `download` saves it instead of showing it. */
  readonly src: (path: string, download?: boolean) => string;
  /** Where a relative path starts, and the reference prefixes the chat links (`vfs`, `computer`, a device's name). */
  readonly home: string;
  readonly roots: readonly string[];
  /** Opens the Files tab on the file. */
  readonly reveal: (path: string) => void;
}

export const ChatImageContext = createContext<ChatImageSource | null>(null);

export type Picture =
  | { readonly kind: "file"; readonly key: string; readonly path: string; readonly machine: ImageMachine; readonly device?: string }
  | { readonly kind: "data"; readonly key: string; readonly label: string; readonly src: string }
  | { readonly kind: "web"; readonly key: string; readonly url: string; readonly host: string };

const ToolImagesSchema = v.object({
  type: v.literal("kinu/images"),
  output: v.unknown(),
  images: v.array(v.object({ mediaType: v.string(), data: v.string() })),
});

const SavedSchema = v.looseObject({ path: v.string() });

/** What a tool's output can say about a picture: the images it carried, the file it saved, or words naming one. */
const ToolOutputSchema = v.union([ToolImagesSchema, SavedSchema, v.string()]);

type ToolOutput = v.InferOutput<typeof ToolOutputSchema>;

type Saved = string | v.InferOutput<typeof SavedSchema>;

function filePicture(image: Extract<NamedImage, { kind: "file" }>): Picture {
  return { kind: "file", key: image.path, path: image.path, machine: image.machine, ...(image.device !== undefined && { device: image.device }) };
}

function pictureOf(image: NamedImage): Picture {
  return image.kind === "file" ? filePicture(image) : { kind: "web", key: image.url, url: image.url, host: image.host };
}

/** The first file `output` names: a saved screenshot's `path`, or a read's reference in its description. */
function savedFile(output: Saved, at: ChatImageSource): Picture[] {
  return namedImages(typeof output === "string" ? output : output.path, at).filter((image) => image.kind === "file").slice(0, 1).map(pictureOf);
}

/** A tool's pictures: the file it saved when it names one, else the images it carried. */
function toolPictures(output: ToolOutput, at: ChatImageSource): Picture[] {
  if (!v.is(ToolImagesSchema, output)) return savedFile(output, at);
  const inner = v.safeParse(v.union([SavedSchema, v.string()]), output.output);
  const saved = inner.success ? savedFile(inner.output, at) : [];

  if (saved.length > 0) return saved;

  return output.images.map((image, index) => ({
    kind: "data", key: `data:${String(index)}:${image.data.slice(0, 32)}`, label: `Image ${String(index + 1)}`,
    src: `data:${image.mediaType};base64,${image.data}`,
  }));
}

function pictureSrc(picture: Picture, at: ChatImageSource): string {
  if (picture.kind === "file") return at.src(picture.path);

  return picture.kind === "data" ? picture.src : picture.url;
}

/** A picture's name as the chat writes paths: a workspace file from its home, any other from its root. */
function pictureName(picture: Picture, home: string): string {
  if (picture.kind === "file") return picture.path.startsWith(`${home}/`) ? picture.path.slice(home.length + 1) : picture.path;

  return picture.kind === "data" ? picture.label : picture.url;
}

/** Every picture a settled answer shows, by the part it follows, each once: a tool's first, then the words'. */
export function messagePictures(message: UIMessage, at: ChatImageSource, settled: (part: UIMessage["parts"][number]) => boolean): ReadonlyMap<UIMessage["parts"][number], readonly Picture[]> {
  const shown = new Set<string>();
  const byPart = new Map<UIMessage["parts"][number], readonly Picture[]>();

  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;
    const output = v.safeParse(ToolOutputSchema, part.output);

    if (!output.success) continue;
    const pictures = toolPictures(output.output, at).filter((picture) => !shown.has(picture.key));

    for (const picture of pictures) shown.add(picture.key);

    if (pictures.length > 0) byPart.set(part, pictures);
  }

  for (const part of message.parts) {
    if (part.type !== "text" || !settled(part)) continue;
    const text = drawnText(part);

    if (text === null) continue;
    const pictures = namedImages(text, at).map(pictureOf).filter((picture) => !shown.has(picture.key));

    for (const picture of pictures) shown.add(picture.key);

    if (pictures.length > 0) byPart.set(part, pictures);
  }

  return byPart;
}

const WHERE: Record<ImageMachine, { readonly icon: Icon; readonly label: (device?: string) => string; readonly missing: string }> = {
  workspace: { icon: FolderSimpleIcon, label: () => "Workspace", missing: "Not in the workspace" },
  computer: { icon: TerminalWindowIcon, label: () => "Computer", missing: "Not on the computer" },
  device: { icon: LaptopIcon, label: (device) => device ?? "Device", missing: "Not on the device, or it is offline" },
};

function Where({ machine, device }: { readonly machine: ImageMachine; readonly device?: string | undefined }) {
  const { icon: Glyph, label } = WHERE[machine];

  return <span className="p-shot-where"><Glyph size={11} aria-hidden />{label(device)}</span>;
}

function Note({ icon: Glyph, children, action }: { readonly icon: Icon; readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="p-shot-note my-1" role="status">
      <Glyph size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}

/** One picture: as large as it is up to the column (and 360px tall, 200px under a tool's row), its name beneath. */
function Shot({ picture, size, onOpen }: { readonly picture: Picture; readonly size: "full" | "thumb"; readonly onOpen: () => void }) {
  const at = useContext(ChatImageContext);
  const [state, setState] = useState<"loading" | "shown" | "missing">("loading");
  const [asked, setAsked] = useState(false);

  if (at === null) return null;

  if (picture.kind === "web" && !asked) {
    return (
      <Note icon={GlobeIcon} action={<button type="button" className="p-pill-action" onClick={() => setAsked(true)}>Show image</button>}>
        An image from <span className="p-text-2">{picture.host}</span>. It loads from that site when you show it.
      </Note>
    );
  }

  if (picture.kind === "file" && state === "missing") {
    return <Note icon={ImageBrokenIcon}>{WHERE[picture.machine].missing}: <span className="font-mono p-text-2">{pictureName(picture, at.home)}</span></Note>;
  }

  if (picture.kind === "web" && state === "missing") {
    return <Note icon={ImageBrokenIcon}>Could not load the image from <span className="p-text-2">{picture.host}</span></Note>;
  }

  const src = pictureSrc(picture, at);
  const name = pictureName(picture, at.home);

  return (
    <figure className="p-shot my-2" data-size={size} data-chat-image={picture.kind}>
      <button type="button" className="p-shot-frame" aria-label={`Open ${name}`} onClick={onOpen}>
        {state === "loading" && <span className="p-shot-wait p-skeleton-bar !rounded-none" aria-hidden />}
        <img src={src} alt={name} loading="lazy" decoding="async" {...(picture.kind === "web" && { referrerPolicy: "no-referrer" as const })}
          className={state === "loading" ? "absolute size-px opacity-0" : undefined}
          onLoad={() => setState("shown")} onError={() => setState("missing")} />
      </button>
      <figcaption className="p-shot-caption">
        <span className="p-shot-name" title={name}>{name}</span>
        {picture.kind === "file" && (
          <>
            <Where machine={picture.machine} device={picture.device} />
            <button type="button" className="p-pill-icon" aria-label="Show in Files" title="Show in Files" onClick={() => at.reveal(picture.path)}>
              <FolderSimpleIcon size={13} />
            </button>
            <a className="p-pill-icon" href={at.src(picture.path, true)} aria-label="Download" title="Download"><DownloadSimpleIcon size={13} /></a>
          </>
        )}
      </figcaption>
    </figure>
  );
}

/** The pictures one part shows: one at its size, two or more in a grid. */
export function Pictures({ pictures, size, open }: { readonly pictures: readonly Picture[]; readonly size: "full" | "thumb"; readonly open: (picture: Picture) => void }) {
  const shots = pictures.map((picture) => <Shot key={picture.key} picture={picture} size={size} onOpen={() => open(picture)} />);

  if (pictures.length > 1 && pictures.every((picture) => picture.kind !== "web")) return <div className="p-shot-grid my-2" data-size={size}>{shots}</div>;

  return <>{shots}</>;
}

/** A picture opened whole: fit to the window, its name and machine above, the message's others a step away. */
export function Lightbox({ pictures, index, onIndex, onClose }: {
  readonly pictures: readonly Picture[]; readonly index: number; readonly onIndex: (index: number) => void; readonly onClose: () => void;
}) {
  const at = useContext(ChatImageContext);
  const picture = pictures[index];
  const many = pictures.length > 1;

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();

      if (event.key === "ArrowLeft" && many) onIndex((index - 1 + pictures.length) % pictures.length);

      if (event.key === "ArrowRight" && many) onIndex((index + 1) % pictures.length);
    };

    window.addEventListener("keydown", key);

    return () => window.removeEventListener("keydown", key);
  }, [index, many, onClose, onIndex, pictures.length]);

  if (at === null || picture === undefined) return null;
  const src = pictureSrc(picture, at);
  const name = pictureName(picture, at.home);

  // Above every pane, whatever transform an answer's entrance leaves on its column.
  return createPortal(
    <div className="p-lightbox" role="dialog" aria-modal aria-label={name} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="p-lightbox-bar">
        <span className="min-w-0 truncate font-mono p-text">{name}</span>
        {picture.kind === "file" && <Where machine={picture.machine} device={picture.device} />}
        {many && <span className="shrink-0 p-meta p-text-3 tabular-nums">{index + 1} of {pictures.length}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {picture.kind === "file" && (
            <>
              <button type="button" className="p-pill-action !bg-transparent p-text-2" onClick={() => { onClose(); at.reveal(picture.path); }}>
                <FolderSimpleIcon size={14} />Show in Files
              </button>
              <a className="p-pill-icon" href={at.src(picture.path, true)} aria-label="Download" title="Download"><DownloadSimpleIcon size={15} /></a>
            </>
          )}
          <button type="button" className="p-pill-icon" aria-label="Close" onClick={onClose}><XIcon size={15} weight="bold" /></button>
        </span>
      </div>
      <div className="p-lightbox-stage relative" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        {many && (
          <button type="button" className="p-lightbox-step left-4" aria-label="Previous" onClick={() => onIndex((index - 1 + pictures.length) % pictures.length)}>
            <ArrowLeftIcon size={15} />
          </button>
        )}
        <img src={src} alt={name} {...(picture.kind === "web" && { referrerPolicy: "no-referrer" as const })} />
        {many && (
          <button type="button" className="p-lightbox-step right-4" aria-label="Next" onClick={() => onIndex((index + 1) % pictures.length)}>
            <ArrowRightIcon size={15} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
