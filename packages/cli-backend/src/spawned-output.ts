// Spawned-process output reader shared by the local subscription providers.
//
// The `claude` and `opencode` bridges drain a child stdout the same way, so
// the reader lives here once instead of once per provider.
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

/**
 * Read failure carried out as a value instead of thrown. Every caller pairs
 * this with the child exit outcome. That outcome says whether the failure is
 * already explained. That decision cannot be made inside a catch, so the
 * error travels out as data.
 */
export async function readAllOutcome(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<{ text: string } | { error: unknown }> {
  try {
    return { text: await readAll(stream) };
  } catch (error) {
    return { error };
  }
}
