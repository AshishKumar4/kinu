/** Arms in flight: a release never cancels a keeper. */
export class WakeArms {
  private inFlight = 0;

  private started = 0;

  async arm<T>(body: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.started += 1;

    try {
      return await body();
    } finally {
      this.inFlight -= 1;
    }
  }

  async release(ports: {
    rows(): Promise<readonly string[]>;
    idle(): boolean;
    cancel(id: string): Promise<void>;
    rearm(): Promise<void>;
  }): Promise<void> {
    const started = this.started;
    let cancelled = false;

    try {
      for (const id of await ports.rows()) {
        if (this.inFlight > 0 || this.started !== started || !ports.idle()) return;
        cancelled = true;
        await ports.cancel(id);
      }
    } finally {
      if (cancelled && this.started !== started) await ports.rearm();
    }
  }
}
