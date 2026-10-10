/** Runtime's own invocation CPU/wall counters, delivered outside the measured product. */
interface TailEnv { readonly SINK: Fetcher }

export default {
  async tail(events: readonly TraceItem[], env: TailEnv): Promise<void> {
    const recorded = events.map((event) => ({
      entrypoint: event.entrypoint ?? null, object: event.durableObjectId ?? null, cpuMs: event.cpuTime, wallMs: event.wallTime,
      outcome: event.outcome, event: event.event, script: event.scriptName,
    }));

    await env.SINK.fetch('http://measure.invalid', { method: 'POST', body: JSON.stringify(recorded) });
  },
};
