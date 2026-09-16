// A fetch bounded by a clock rather than by the server's own answer.
export async function probe(url: string): Promise<number> {
  const answer = await fetch(url, { signal: AbortSignal.timeout(5_000) });

  return answer.status;
}
