import { describe, expect, test } from "bun:test";
import { createPlanAnnotationSaveQueue } from "../src/components/surfaces/plan-annotation-save";

interface Deferred {
  readonly promise: Promise<boolean>;
  resolve(value: boolean): void;
}

function deferred(): Deferred {
  let settle: (value: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
}

describe("plan annotation save queue", () => {
  test("serializes replacement writes so an older snapshot cannot land last", async () => {
    const writes: string[][] = [];
    const completions: Deferred[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = createPlanAnnotationSaveQueue<{ id: string }>(async (values) => {
      writes.push(values.map((value) => value.id));
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const completion = deferred();
      completions.push(completion);
      const result = await completion.promise;
      concurrent--;
      return result;
    });

    const first = queue.enqueue([{ id: "a" }]);
    const second = queue.enqueue([{ id: "a" }, { id: "b" }]);

    expect(writes).toEqual([]);
    await Promise.resolve();
    expect(writes).toEqual([["a"]]);
    expect(queue.pending()).toBe(2);

    completions[0]?.resolve(true);
    await first;
    await Promise.resolve();
    expect(writes).toEqual([["a"], ["a", "b"]]);

    completions[1]?.resolve(true);
    await second;
    expect(maxConcurrent).toBe(1);
    expect(queue.pending()).toBe(0);
  });

  test("continues with the newest snapshot after a failed write", async () => {
    const writes: string[][] = [];
    const queue = createPlanAnnotationSaveQueue<{ id: string }>(async (values) => {
      writes.push(values.map((value) => value.id));
      return writes.length > 1;
    });

    expect(await queue.enqueue([{ id: "old" }])).toBe(false);
    expect(await queue.enqueue([{ id: "new" }])).toBe(true);
    expect(writes).toEqual([["old"], ["new"]]);
  });
});
