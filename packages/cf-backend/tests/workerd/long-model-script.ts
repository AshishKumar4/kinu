import { WORKSPACE_TITLE_SYSTEM_PROMPT } from '../../../core/src/identity/naming';
import { sleepTimeScript } from '../../../../scripts/sleep-time-script';
import { readScriptedRequest, scriptedBody, type ScriptedAnswer, type ScriptedRequest } from '../../../../scripts/scripted-protocol';

/** The words a workspace's title is asked for, answered the way the product parses one. */
export const PROBE_TITLE = 'Long Probe';

const titleScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.streamed || request.available.length !== 0 || !request.system.startsWith(WORKSPACE_TITLE_SYSTEM_PROMPT)) return null;

  return { text: JSON.stringify({ title: PROBE_TITLE }) };
};

export interface ScriptedHttpAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * What `probe-long` answers for the lanes around its streamed turns: the background memory pass and the workspace
 * title, each in the shape its request asked for (one completion when it did not ask for a stream), through the
 * scripted protocol the tiers' scripted model speaks. Null for a request that is not one of those, which is the
 * probe's own streamed turn.
 */
export function scriptedLongAnswer(raw: string): ScriptedHttpAnswer | null {
  const read = readScriptedRequest(raw);

  if ('refusal' in read) return { status: read.refusal.status, contentType: 'application/json', body: read.refusal.body };
  const answer = sleepTimeScript(read.request) ?? titleScript(read.request);

  return answer === null ? null : { status: 200, ...scriptedBody(answer, read.request) };
}
