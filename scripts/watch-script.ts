/**
 * The scripted model's watcher workload: `KINU_WATCH arm` makes the agent schedule a watcher every minute whose check
 * reads `/scratch/watch-flag.md` and fires when its text changed, `KINU_WATCH flag <text>` writes that file, and a turn
 * the watcher woke answers `KINU_WATCH_FIRED`. A quiet minute costs a check and no model call, which the staging proof
 * counts.
 */
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

const ARM = 'KINU_WATCH arm';

const FLAG = /KINU_WATCH flag (\S+)/u;

const FLAG_PATH = '/scratch/watch-flag.md';

/** The check: the flag's text against the last text it fired on. */
const CHECK = [
  `const read = await file.text('${FLAG_PATH}');`,
  "const text = typeof read === 'string' ? read.trim() : '';",
  "const seen = state === null ? '' : state.seen;",
  "return text !== '' && text !== seen ? { fire: true, brief: `flag: ${text}`, state: { seen: text } } : { fire: false, state: { seen } };",
].join('\n');

export function watchScript(request: ScriptedRequest): ScriptedAnswer | null {
  const latest = request.userTexts.at(-1) ?? '';

  if (latest.includes('Its check found this')) return { text: 'KINU_WATCH_FIRED' };
  const flag = FLAG.exec(latest);

  if (flag !== null) {
    return request.turn.length > 0
      ? { text: 'Flagged.' }
      : { text: 'Writing the flag.', toolCall: { name: 'file', arguments: { op: 'write', path: FLAG_PATH, content: flag[1] ?? '' } } };
  }

  if (!latest.includes(ARM)) return null;

  if (request.turn.length > 0) return { text: 'Armed.' };

  return { text: 'Arming the watcher.', toolCall: { name: 'eval', arguments: {
    code: `// Arms the watch-flag watcher.\nreturn await agent.schedule({ cron: '* * * * *', label: 'watch-flag', check: { code: ${JSON.stringify(CHECK)}, reads: ['file'] } });`,
  } } };
}
