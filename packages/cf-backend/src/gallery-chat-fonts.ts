/**
 * The chat faces under the owner's review, for the gallery build alone: nothing the app imports names them, so they never
 * ship. Each is fontsource's latin variable cut (OFL, beside it in `gallery-fonts/`). `<html data-chat-font>` sets the
 * assistant's prose and the person's bubble in one, sized so its x-height matches Schibsted Grotesk's at today's 14.5px
 * (each face's own OS/2 sxHeight) and led per face; unnamed, the chat is as it ships.
 */
import interUrl from "@/gallery-fonts/inter-latin-opsz.woff2?url";
import geistUrl from "@/gallery-fonts/geist-latin-wght.woff2?url";
import plexUrl from "@/gallery-fonts/ibm-plex-sans-latin-wght.woff2?url";
import instrumentUrl from "@/gallery-fonts/instrument-sans-latin-wght.woff2?url";

interface ChatFace {
  readonly label: string;
  readonly family: string | null;
  readonly url: string | null;
  /** OS/2 sxHeight over unitsPerEm. */
  readonly xHeight: number;
  /** Line height at the workbench's prose size. */
  readonly leading: number;
  readonly tracking: string;
}

const SCHIBSTED_X_HEIGHT = 0.527;

export const CHAT_FACES = {
  schibsted: { label: "Schibsted Grotesk", family: null, url: null, xHeight: SCHIBSTED_X_HEIGHT, leading: 1.7, tracking: "-0.006em" },
  inter: { label: "Inter", family: "Gallery Inter", url: interUrl, xHeight: 0.546, leading: 1.72, tracking: "-0.006em" },
  geist: { label: "Geist", family: "Gallery Geist", url: geistUrl, xHeight: 0.53, leading: 1.7, tracking: "0em" },
  plex: { label: "IBM Plex Sans", family: "Gallery IBM Plex Sans", url: plexUrl, xHeight: 0.516, leading: 1.65, tracking: "0em" },
  instrument: { label: "Instrument Sans", family: "Gallery Instrument Sans", url: instrumentUrl, xHeight: 0.51, leading: 1.65, tracking: "0em" },
} as const satisfies Record<string, ChatFace>;

export type ChatFaceName = keyof typeof CHAT_FACES;

export const CHAT_FACE_NAMES = Object.keys(CHAT_FACES).filter((name): name is ChatFaceName => name in CHAT_FACES);

/** The prose and bubble sizes the chat ships at, in rem: the workbench's (WorkspacePage) and the default's. */
const SHIPPED = { workbench: { prose: 0.906, bubble: 0.875 }, page: { prose: 1, bubble: 1 } } as const;

function faceCss(name: ChatFaceName): string {
  const face: ChatFace = CHAT_FACES[name];

  if (face.family === null || face.url === null) return "";
  const ratio = SCHIBSTED_X_HEIGHT / face.xHeight;
  const stack = `"${face.family}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const on = `:root[data-chat-font="${name}"]`;
  const rem = (value: number) => `${(value * ratio).toFixed(4)}rem`;

  return [
    `@font-face{font-family:"${face.family}";src:url("${face.url}") format("woff2-variations");font-weight:100 900;font-style:normal;font-display:swap}`,
    `${on} .prose-chat{font-family:${stack};font-size:${rem(SHIPPED.page.prose)};letter-spacing:${face.tracking}}`,
    `${on} .p-t-chat{font-family:${stack};font-size:${rem(SHIPPED.page.bubble)}}`,
    `${on} :is([data-workbench],.p-workbench) .prose-chat{font-size:${rem(SHIPPED.workbench.prose)};line-height:${String(face.leading)}}`,
    `${on} :is([data-workbench],.p-workbench) .prose-chat :is(h1,h2,h3){line-height:${String(face.leading)}}`,
    `${on} :is([data-workbench],.p-workbench) .p-t-chat{font-size:${rem(SHIPPED.workbench.bubble)}}`,
  ].join("\n");
}

/** Once per page: every face's rules, which wait on `data-chat-font` to name one. */
export function installChatFaces(): void {
  if (document.querySelector("style[data-gallery-chat-fonts]") !== null) return;
  const style = document.createElement("style");

  style.dataset.galleryChatFonts = "";
  style.textContent = CHAT_FACE_NAMES.map(faceCss).join("\n");
  document.head.appendChild(style);
}
