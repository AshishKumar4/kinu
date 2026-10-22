/**
 * Which surface the workspace's inspector shows, and every way something asks for one: a chat's file link, a change
 * note, a slate, a plan, and the `?file=`, `?slate=` and fork landings a URL carries. Whatever is asked for is brought
 * into view, even from a collapsed inspector or a phone showing the chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  cloudPlanes, filesFocusOf, PLANE, referencePrefixes, SLATE_PREFIX, WORKSPACE_ROOT,
  type DiffAnchor, type ExecutorInfo, type FilesFocus, type SlateSummary, type SurfaceKind,
} from "@kinu.run/core";
import type { ChangesFocus } from "@/components/surfaces/ChangesSurface";
import type { WorkbenchHandle } from "@/components/WorkbenchPanels";
import type { ChatImageSource } from "@/components/ChatImages";

/** A chat's file links: the prefixes it links, and what opens one. */
interface FileLinks {
  readonly roots: readonly string[];
  readonly open: (reference: string) => void;
}

/** A fork's landing: the slate it opens on, and the namespaces it reaches, from `?slate=&reaches=`. */
type ForkLanding = { readonly slate: string; readonly reaches: readonly string[] };

function forkLandingOf(search: URLSearchParams): ForkLanding | null {
  const slate = search.get("slate");
  const reaches = search.get("reaches");

  if (slate === null || reaches === null) return null;

  return { slate, reaches: reaches.split(",").filter((namespace) => namespace !== "") };
}

interface WorkbenchSurfaces {
  readonly workbench: RefObject<WorkbenchHandle | null>;
  readonly surface: SurfaceKind;
  /** Picks a surface where the inspector already shows. */
  readonly setSurface: (surface: SurfaceKind) => void;
  /** Picks a surface and brings the inspector into view. */
  readonly show: (surface: SurfaceKind) => void;
  readonly filesFocus: FilesFocus | null;
  readonly fileLinks: FileLinks;
  /** Where the chat reads the pictures it shows, and opens one in Files. */
  readonly chatImages: ChatImageSource;
  readonly changesFocus: ChangesFocus | null;
  readonly openChangeNote: (source: string, anchor: DiffAnchor | undefined) => void;
  readonly forkLanding: ForkLanding | null;
  readonly forkLandingOpened: () => void;
  /** The page opened on `?environment=desktop`: Environment shows the chosen machine's desktop, once. */
  readonly desktopLanding: boolean;
  readonly desktopLanded: () => void;
}

/** The landing that opens Environment on the chosen machine's desktop: what `/workspace/:id/desktop` became (D99). */
export const DESKTOP_LANDING = "environment=desktop";

/** `search`: the page's query, for its landings (most read once, at mount). `inspectorReady`: the workbench's layout is decided. */
export function useWorkbenchSurfaces({ workspace, executors, slates, search, inspectorReady }: {
  workspace: string;
  executors: readonly ExecutorInfo[];
  slates: readonly SlateSummary[];
  search: string;
  inspectorReady: boolean;
}): WorkbenchSurfaces {
  const workbench = useRef<WorkbenchHandle | null>(null);
  const [filesFocus, setFilesFocus] = useState<FilesFocus | null>(null);
  const [changesFocus, setChangesFocus] = useState<ChangesFocus | null>(null);
  const [landingFile, setLandingFile] = useState<string | null>(() => new URLSearchParams(search).get("file"));
  // The jump to a fork's slate waits until the listing names the slate.
  const [landingSlate, setLandingSlate] = useState<string | null>(() => new URLSearchParams(search).get("slate"));
  const [forkLanding, setForkLanding] = useState(() => forkLandingOf(new URLSearchParams(search)));
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  // `?environment=desktop` opens Environment, once the inspector's layout is decided (a reveal before it is undone), and
  // Environment shows the chosen machine's desktop; each lets go once it has. Followed, not read once: the desktop's old
  // address redirects here within the same page, which stays mounted across the workspace's own routes.
  const [desktopLanding, setDesktopLanding] = useState(false);
  const [environmentLanding, setEnvironmentLanding] = useState(false);
  const asksDesktop = new URLSearchParams(search).get("environment") === "desktop";

  useEffect(() => {
    if (!asksDesktop) return;
    setDesktopLanding(true);
    setEnvironmentLanding(true);
  }, [asksDesktop]);

  const show = useCallback((next: SurfaceKind): void => {
    setSurface(next);
    workbench.current?.reveal();
  }, []);

  // A chat file link, or a `?file=<reference>` landing, opens Files on the file it names.
  const openFile = useCallback((reference: string): void => {
    const focus = filesFocusOf(reference);

    if (focus === null) return;
    setFilesFocus((prior) => ({ ...focus, nonce: (prior?.nonce ?? 0) + 1 }));
    show("Files");
  }, [show]);

  // Every prefix, and each live machine's own name: `<name>://x` opens that machine's file in Files.
  const machines = useMemo(() => executors.flatMap((executor) => executor.mounts ?? []), [executors]);
  const fileLinks = useMemo(() => ({ roots: referencePrefixes(cloudPlanes(WORKSPACE_ROOT), machines), open: openFile }), [machines, openFile]);

  const chatImages = useMemo((): ChatImageSource => ({
    src: (path, download = false) => `/api/workspaces/${encodeURIComponent(workspace)}/files`
      + `?executor=${encodeURIComponent(PLANE)}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`,
    home: WORKSPACE_ROOT,
    roots: fileLinks.roots,
    reveal: (path) => openFile(`vfs://${path.replace(/^\//u, "")}`),
  }), [workspace, fileLinks.roots, openFile]);

  useEffect(() => {
    if (landingFile === null) return;
    openFile(landingFile);
    setLandingFile(null);
  }, [landingFile, openFile]);

  const openChangeNote = useCallback((source: string, anchor: DiffAnchor | undefined): void => {
    show("Changes");
    setChangesFocus((prior) => ({ source, path: anchor?.path ?? null, nonce: (prior?.nonce ?? 0) + 1 }));
  }, [show]);

  useEffect(() => {
    if (landingSlate === null || !slates.some((slate) => slate.id === landingSlate)) return;
    show(`${SLATE_PREFIX}${landingSlate}`);
    setLandingSlate(null);
  }, [landingSlate, slates, show]);

  useEffect(() => {
    if (!environmentLanding || !inspectorReady) return;
    show("Environment");
    setEnvironmentLanding(false);
  }, [environmentLanding, inspectorReady, show]);

  const forkLandingOpened = useCallback(() => setForkLanding(null), []);
  const desktopLanded = useCallback(() => setDesktopLanding(false), []);

  return {
    workbench, surface, setSurface, show, filesFocus, fileLinks, chatImages, changesFocus, openChangeNote, forkLanding, forkLandingOpened,
    desktopLanding, desktopLanded,
  };
}
