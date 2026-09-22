// Child stdout reader shared by the `claude` and `opencode` bridges.
import * as v from 'valibot';

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';

  for await (const chunk of stream) {
    const text = v.safeParse(v.string(), chunk);
    out += text.success
      ? text.output
      : decoder.decode(v.parse(v.instance(Uint8Array), chunk), { stream: true });
  }

  out += decoder.decode();

  return out;
}

/** Read failure returned as a value; callers judge it against the child's exit outcome. */
export async function readAllOutcome(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<{ text: string } | { error: unknown }> {
  try {
    return { text: await readAll(stream) };
  } catch (error) {
    return { error };
  }
}
