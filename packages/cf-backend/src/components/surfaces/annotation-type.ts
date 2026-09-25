import { AnnotationType } from "@plannotator/ui/types";
import type { ReviewAnnotation } from "@kinu.run/core";

export function annotationType(value: ReviewAnnotation["type"]): AnnotationType {
  if (value === "DELETION") return AnnotationType.DELETION;

  if (value === "GLOBAL_COMMENT") return AnnotationType.GLOBAL_COMMENT;

  return AnnotationType.COMMENT;
}

export function storedType(value: AnnotationType): ReviewAnnotation["type"] {
  if (value === AnnotationType.DELETION) return "DELETION";

  if (value === AnnotationType.GLOBAL_COMMENT) return "GLOBAL_COMMENT";

  return "COMMENT";
}
