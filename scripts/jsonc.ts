import * as v from 'valibot';

/** Parse script configuration with Bun's JSONC grammar, then validate its domain shape. */
export function parseJsonc<TSchema extends v.GenericSchema>(
  source: string,
  schema: TSchema,
  label: string,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, Bun.JSONC.parse(source));

  if (!parsed.success) throw new Error(`${label}: ${v.summarize(parsed.issues)}`);

  return parsed.output;
}
