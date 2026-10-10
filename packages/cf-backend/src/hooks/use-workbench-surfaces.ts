/**
 * Which surface the workspace's inspector shows, and every way something asks for one: a chat's file link, a change
 * note, a slate, a plan, and the `?file=`, `?slate=` and fork landings a URL carries. Whatever is asked for is brought
 * into view, even from a collapsed inspector or a phone showing the chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  cloudPlanes, filesFocusOf, referencePrefixes, SLATE_PREFIX, WORKSPACE_ROOT,
  type DiffAnchor, type ExecutorInfo, type FilesFocus, type SlateSummary, type SurfaceKind,
} from "@kinu.run/core";
import type { ChangesFocus } from "@/components/surfaces/ChangesSurface";
import type { WorkbenchHandle } from "@/components/WorkbenchPanels";

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

export interface WorkbenchSurfaces {
  readonly workbench: RefObject<WorkbenchHandle | null>;
  readonly surface: SurfaceKind;
  /** Picks a surface where the inspector already shows. */
  readonly setSurface: (surface: SurfaceKind) => void;
  /** Picks a surface and brings the inspector into view. */
  readonly show: (surface: SurfaceKind) => void;
  readonly filesFocus: FilesFocus | null;
  readonly fileLinks: FileLinks;
  readonly changesFocus: ChangesFocus | null;
  readonly openChangeNote: (source: string, anchor: DiffAnchor | undefined) => void;
  readonly forkLanding: ForkLanding | null;
  readonly forkLandingOpened: () => void;
}

/** `search`: the URL the page opened on, read once for its landings. */
export function useWorkbenchSurfaces({ executors, slates, search }: {
  executors: readonly ExecutorInfo[];
  slates: readonly SlateSummary[];
  search: string;
}): WorkbenchSurfaces {
  const workbench = useRef<WorkbenchHandle | null>(null);
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  const [filesFocus, setFilesFocus] = useState<FilesFocus | null>(null);
  const [changesFocus, setChangesFocus] = useState<ChangesFocus | null>(null);
  const [landingFile, setLandingFile] = useState<string | null>(() => new URLSearchParams(search).get("file"));
  // The jump to a fork's slate waits until the listing names the slate.
  const [landingSlate, setLandingSlate] = useState<string | null>(() => new URLSearchParams(search).get("slate"));
  const [forkLanding, setForkLanding] = useState(() => forkLandingOf(new URLSearchParams(search)));

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

  const forkLandingOpened = useCallback(() => setForkLanding(null), []);

  return { workbench, surface, setSurface, show, filesFocus, fileLinks, changesFocus, openChangeNote, forkLanding, forkLandingOpened };
}
