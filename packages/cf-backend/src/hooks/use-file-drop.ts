import { useCallback, useState, type DragEvent } from "react";

interface FileDropHandlers {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

interface FileDrop {
  dragOver: boolean;
  handlers: FileDropHandlers;
}

/** Lit while files hover, children included. `onFiles` must be stable. */
export function useFileDrop(onFiles: (files: FileList) => void): FileDrop {
  const [dragOver, setDragOver] = useState(false);

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    onFiles(e.dataTransfer.files);
  }, [onFiles]);

  return { dragOver, handlers: { onDragOver, onDragLeave, onDrop } };
}
