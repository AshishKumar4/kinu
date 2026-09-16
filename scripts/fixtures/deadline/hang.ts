// A run that never ends: what the deadline exists to end. Not a test file,
// so no runner discovers it; `scripts/deadline.test.ts` spawns it on purpose.
console.log('hanging');

await new Promise<never>(() => {});
