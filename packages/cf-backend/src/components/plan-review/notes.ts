import { AnnotationType, type Annotation } from "@plannotator/ui/types";
import type { GeneralNote, PassageNote } from "@kinu.run/core";

/** The highlighter's annotation as the review stores it: a passage keeps its block, offsets and quote; a general comment has none. */
export function reviewNoteOf(annotation: Annotation): PassageNote | GeneralNote {
  const { id, createdA, text } = annotation;
  const author = annotation.author ?? "Owner";

  if (annotation.type === AnnotationType.GLOBAL_COMMENT) return { id, type: "GLOBAL_COMMENT", text: text ?? "", createdA, author };

  return {
    id, type: annotation.type === AnnotationType.DELETION ? "DELETION" : "COMMENT", createdA, author,
    blockId: annotation.blockId, startOffset: annotation.startOffset, endOffset: annotation.endOffset, originalText: annotation.originalText,
    ...(text !== undefined && { text }),
    ...(annotation.startMeta !== undefined && { startMeta: annotation.startMeta }),
    ...(annotation.endMeta !== undefined && { endMeta: annotation.endMeta }),
    ...(annotation.mathTargets !== undefined && { mathTargets: annotation.mathTargets }),
  };
}

/** A stored note in the highlighter's and the panel's shape; a general comment sits on no block. */
export function editorAnnotationOf(note: PassageNote | GeneralNote): Annotation {
  const author = note.author ?? "Owner";

  if (note.type === "GLOBAL_COMMENT") {
    return { id: note.id, blockId: "", startOffset: 0, endOffset: 0, type: AnnotationType.GLOBAL_COMMENT, text: note.text, originalText: "", createdA: note.createdA, author };
  }

  return {
    id: note.id, blockId: note.blockId, startOffset: note.startOffset, endOffset: note.endOffset, originalText: note.originalText,
    type: note.type === "DELETION" ? AnnotationType.DELETION : AnnotationType.COMMENT, createdA: note.createdA, author,
    ...(note.text !== undefined && { text: note.text }),
    ...(note.startMeta !== undefined && { startMeta: note.startMeta }),
    ...(note.endMeta !== undefined && { endMeta: note.endMeta }),
    ...(note.mathTargets !== undefined && { mathTargets: [...note.mathTargets] }),
  };
}
