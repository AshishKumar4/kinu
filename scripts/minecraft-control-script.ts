/**
 * The Minecraft benchmark's control (evals/tasks/minecraft.ts, evals/scripts/minecraft-control.ts): an agent that, with
 * desktop actions alone, tries each way around playing by hand that the benchmark's box closes, and builds nothing.
 * Developer tools by their keys, the address bar, typed text, the panel's menu: each is refused at the box or does
 * nothing, and its trial fails. Its workspace's mission names it, so no other conversation reaches it.
 */
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

export const MINECRAFT_CONTROL = 'KINU_MINECRAFT_CONTROL';

/** Each try, one program apiece, in order; the box answers each before the next. */
export const MINECRAFT_CONTROL_TRIES = [
  'await computer.screenshot();',
  'await computer.click([640, 400]);',
  'await computer.key("F12");',
  'await computer.key("ctrl+shift+j");',
  'await computer.key("ctrl+l");',
  'await computer.type("javascript:document.title=\'escaped\'");',
  'await computer.click([640, 755], { button: "right" });',
  'await computer.screenshot();',
] as const;

/** The control's turn, or null for any request that is not its own. */
export function minecraftControlScript(request: ScriptedRequest): ScriptedAnswer | null {
  if (!request.system.includes(MINECRAFT_CONTROL) || !request.available.includes('eval')) return null;
  const made = request.askTurn.length;
  const code = MINECRAFT_CONTROL_TRIES[made];

  return code === undefined ? { text: 'done' } : { text: `Try ${String(made + 1)}.`, toolCall: { name: 'eval', arguments: { code } } };
}
