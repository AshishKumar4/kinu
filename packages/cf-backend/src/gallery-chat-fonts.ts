/**
 * The faces under the owner's review, for the gallery build alone: nothing the app imports names them, so they never
 * ship. Each is fontsource's latin variable cut (OFL, beside it in `gallery-fonts/`). `<html data-face>` names one, and
 * `data-face-scope` how far it reaches: `chat`, the assistant's prose and the person's bubble; `everywhere`, those and
 * every page's UI and display text (`--font-ui`, `--font-display`). The chat is sized so its x-height matches Schibsted
 * Grotesk's at today's 14.5px (each face's own OS/2 sxHeight) and led per face; the UI sets its roles at their own px.
 * Fragment Mono sets code in every case. Unnamed, every page is as it ships.
 */
import interUrl from "@/gallery-fonts/inter-latin-opsz.woff2?url";
import geistUrl from "@/gallery-fonts/geist-latin-wght.woff2?url";

interface ChatFace {
  readonly label: string;
  /**
   * Its own tracking, by role, where the shipped roles' (set for Schibsted) would be wrong for it everywhere. Inter's
   * optical size already tightens it as it grows, so its body roles want none and its display roles only a little.
   */
  readonly roles?: Readonly<Record<string, string>>;
  readonly family: string | null;
  readonly url: string | null;
  /** OS/2 sxHeight over unitsPerEm. */
  readonly xHeight: number;
  /**
   * The chat's copy of the face drawn this much of its size (`@font-face size-adjust`): Inter's x-height brought to
   * Schibsted's, so the chat reads at the size it ships at. The UI sets the face unadjusted, at its roles' own px.
   */
  readonly sizeAdjust?: number;
  /** Line height at the workbench's prose size. */
  readonly leading: number;
  readonly tracking: string;
}

const SCHIBSTED_X_HEIGHT = 0.527;

export const CHAT_FACES = {
  schibsted: { label: "Schibsted Grotesk", family: null, url: null, xHeight: SCHIBSTED_X_HEIGHT, leading: 1.7, tracking: "-0.006em" },
  inter: {
    label: "Inter", family: "Gallery Inter", url: interUrl, xHeight: 0.546, sizeAdjust: SCHIBSTED_X_HEIGHT / 0.546, leading: 1.72, tracking: "0em",
    roles: {
      // Display (page titles, 24px) and headings: a touch tighter than none; Schibsted's -0.02em and -0.015em pinch it.
      ".p-display": "-0.011em",
      ".p-heading": "-0.008em",
      ".prose-chat :is(h1,h2,h3)": "-0.006em",
      // Body sizes, 11 to 15px: none.
      ".p-title, .p-row-text, .p-meta, .p-button, .p-pill, .p-tool, .p-env-chip, .p-page-link, .p-bar-sizer, .p-bar-link, .p-bar-tab[data-title] :is(.p-bar-sizer, .p-bar-link)": "0em",
    },
  },
  geist: { label: "Geist", family: "Gallery Geist", url: geistUrl, xHeight: 0.53, leading: 1.7, tracking: "0em" },
} as const satisfies Record<string, ChatFace>;

export type ChatFaceName = keyof typeof CHAT_FACES;

export const CHAT_FACE_NAMES = Object.keys(CHAT_FACES).filter((name): name is ChatFaceName => name in CHAT_FACES);

export const FACE_SCOPES = ["chat", "everywhere"] as const;

export type FaceScope = (typeof FACE_SCOPES)[number];

/** The prose and bubble sizes the chat ships at, in rem: the workbench's (WorkspacePage) and the default's. */
const SHIPPED = { workbench: { prose: 0.906, bubble: 0.875 }, page: { prose: 1, bubble: 1 } } as const;

function faceCss(name: ChatFaceName): string {
  const face: ChatFace = CHAT_FACES[name];

  if (face.family === null || face.url === null) return "";
  const adjust = face.sizeAdjust ?? 1;
  const ratio = SCHIBSTED_X_HEIGHT / (face.xHeight * adjust);
  const fallback = `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"`;
  const stack = `"${face.family}", ${fallback}`;
  const chatStack = `"${face.family} Chat", ${fallback}`;
  const on = `:root[data-face="${name}"]`;
  const rem = (value: number) => `${(value * ratio).toFixed(4)}rem`;
  const source = `src:url("${face.url}") format("woff2-variations");font-weight:100 900;font-style:normal;font-display:swap`;

  return [
    `@font-face{font-family:"${face.family}";${source}}`,
    `@font-face{font-family:"${face.family} Chat";${source};size-adjust:${(adjust * 100).toFixed(1)}%}`,
    `${on} .prose-chat{font-family:${chatStack};font-size:${rem(SHIPPED.page.prose)};letter-spacing:${face.tracking}}`,
    `${on} .p-t-chat{font-family:${chatStack};font-size:${rem(SHIPPED.page.bubble)}}`,
    `${on} :is([data-workbench],.p-workbench) .prose-chat{font-size:${rem(SHIPPED.workbench.prose)};line-height:${String(face.leading)}}`,
    `${on} :is([data-workbench],.p-workbench) .prose-chat :is(h1,h2,h3){line-height:${String(face.leading)}}`,
    `${on} :is([data-workbench],.p-workbench) .p-t-chat{font-size:${rem(SHIPPED.workbench.bubble)}}`,
    // Everywhere: the UI's and display's stacks are the face's; every role that names them follows, at its own tracking.
    `${on}[data-face-scope="everywhere"]{--font-ui:${stack};--font-display:${stack}}`,
    ...Object.entries(face.roles ?? {}).map(([roles, tracking]) => `${on}[data-face-scope="everywhere"] :is(${roles}){letter-spacing:${tracking}}`),
  ].join("\n");
}

/** Once per page: every face's rules, which wait on `data-face` to name one. */
export function installChatFaces(): void {
  if (document.querySelector("style[data-gallery-chat-fonts]") !== null) return;
  const style = document.createElement("style");

  style.dataset.galleryChatFonts = "";
  style.textContent = CHAT_FACE_NAMES.map(faceCss).join("\n");
  document.head.appendChild(style);
}
