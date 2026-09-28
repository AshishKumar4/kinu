// A wait bounded by a count: under load the laps run out before the event lands.
export async function until(holds: () => boolean, what: string, nextTurn: () => Promise<void>): Promise<void> {
  for (let lap = 0; lap < 1000; lap++) {
    if (holds()) return;
    await nextTurn();
  }

  throw new Error(`${what}: never held after 1000 event-loop laps`);
}
