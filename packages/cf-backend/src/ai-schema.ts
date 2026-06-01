import type { Schema } from "ai";

/**
 * Bridge a valibot schema into the AI SDK's `generateObject`/`streamObject`
 * `schema` parameter.
 *
 * valibot schemas ARE valid StandardSchema at runtime (the AI SDK's `asSchema`
 * accepts them, and our shadow-eval / heads-merge tests exercise this path),
 * but a type-level version skew between the installed valibot's
 * `~standard` shape and the AI SDK's `FlexibleSchema` constraint makes tsc
 * reject the direct assignment. This cast bridges that skew at the one place
 * it matters, with the caller asserting the result type `T`.
 */
export function aiSchema<T>(schema: unknown): Schema<T> {
  return schema as Schema<T>;
}
