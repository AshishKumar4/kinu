/**
 * The slash commands a chat offers, the CLI's and the web composer's alike: what each one is, named once. Each surface
 * binds the ones it can run and parses their arguments itself; a command means the same thing wherever it is offered.
 */

interface SlashCommandSpec {
  readonly description: string;
  /** Other names that reach the same command, offered by no row of their own. */
  readonly aliases?: readonly `/${string}`[];
}

const SLASH_COMMANDS = {
  '/help': { description: 'List commands and keys' },
  '/status': { description: 'Show this agent\'s mission, model and counts' },
  '/tools': { description: 'List the tools this agent can use' },
  '/model': { description: 'Show or set this workspace\'s model' },
  '/effort': { description: 'Show or set this workspace\'s reasoning effort' },
  '/stats': { description: 'Show each provider account\'s limits and what is left, then usage and API-equivalent cost', aliases: ['/usage', '/cost'] },
  '/accounts': { description: 'Show each provider\'s accounts; choose this workspace\'s or the default' },
  '/role': { description: 'Show or choose this agent\'s role' },
  '/rename': { description: 'Rename this agent. Kinu never renames over a name you chose' },
  '/settings': { description: 'Open settings' },
  '/theme': { description: 'Choose the theme' },
  '/models': { description: 'List configured model providers' },
  '/memory': { description: 'Show the agent\'s memory' },
  '/changelog': { description: 'Review what the agent changed about itself; revert one by number' },
  '/refine': { description: 'Dreams over rated turns, and what each changed' },
  '/takes': { description: 'Compare the latest alternate takes; pick one by number' },
  '/tree': { description: 'Show the swarm search tree' },
  '/jobs': { description: 'List background jobs' },
  '/connect': { description: 'Connect a PC so the agent can run commands on it' },
  '/stop': { description: 'Stop the running turn' },
  '/copy': { description: 'Copy the last answer to the clipboard' },
  '/export': { description: 'Write this conversation to a Markdown file' },
  '/resume': { description: 'Open another workspace and continue its conversation' },
  '/compact': { description: 'Fold this conversation into a summary now, keeping its last exchanges' },
  '/clear': { description: 'Start a new conversation in this workspace; files and memory stay', aliases: ['/new'] },
  '/queue': { description: 'Send a message after the running turn ends' },
  '/branch': { description: 'Try another direction alongside the running turn' },
  '/plan': { description: 'Have the agent draft a plan, then approve it, send it back or dismiss it' },
  '/fork': { description: 'Walk back: restart the conversation just before an earlier message' },
  '/undo': { description: 'Restore files to how they were n turns back, then offer to walk back the chat' },
  '/answer': { description: 'Answer the questions the agent is waiting on' },
  '/approval': { description: 'Show or set when shell commands need your approval' },
  '/instructions': { description: 'Approve which AGENTS.md and skill files the agent follows' },
  '/always': { description: 'Choose skills that are always active' },
  '/advisor': { description: 'Turn the advisor on or off, or set what it reports. On, it reviews every step, with a model call or more each' },
  '/exit': { description: 'Leave the chat', aliases: ['/quit'] },
  '/cancel': { description: 'Close the open overlay' },
} as const satisfies Readonly<Record<`/${string}`, SlashCommandSpec>>;

type SlashCommandName = keyof typeof SLASH_COMMANDS;

/** A command as a palette lists it; `usage` is the surface's own grammar for its arguments. */
export interface SlashCommandInfo {
  readonly name: SlashCommandName;
  readonly description: string;
  readonly usage?: string;
  readonly aliases?: readonly `/${string}`[];
}

/** `name` as the shared list says it, with the grammar the surface that offers it parses. */
export function slashCommand(name: SlashCommandName, usage?: string): SlashCommandInfo {
  return { name, ...SLASH_COMMANDS[name], ...usage !== undefined && { usage } };
}

/** What a palette ranks: a command's name and what it does. */
interface Ranked {
  readonly name: string;
  readonly description: string;
}

/** Lower sorts first; null drops the command. */
function matchRank(query: string, name: string, description: string): number | null {
  if (query === '') return 3;

  if (name === query) return 0;

  if (name.startsWith(query)) return 1;

  if (description.includes(query)) return 2;

  return fuzzySubsequence(query, name) ? 3 : null;
}

function fuzzySubsequence(query: string, target: string): boolean {
  let queryIndex = 0;

  for (const character of target) {
    if (character === query[queryIndex]) queryIndex += 1;

    if (queryIndex === query.length) return true;
  }

  return query.length === 0;
}

/** The commands a draft's first word matches, best first: its exact name, then a name it begins, then a description
 *  it is in, then a name its letters run through in order. A draft that is no command lists none. */
export function filterCommands<T extends Ranked>(commands: readonly T[], draft: string): T[] {
  const token = draft.trimStart();

  if (!token.startsWith('/')) return [];
  const query = token.slice(1).split(/\s+/u, 1)[0]?.toLowerCase() ?? '';

  return commands
    .map((command, index) => ({ command, index, rank: matchRank(query, command.name.slice(1).toLowerCase(), command.description.toLowerCase()) }))
    .filter((candidate): candidate is { command: T; index: number; rank: number } => candidate.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => command);
}

/** A draft that is one word naming a command by a unique match, as that command's name; any other draft as it is. */
export function resolveCommandDraft(commands: readonly Ranked[], draft: string): string {
  const trimmed = draft.trim();

  if (!trimmed.startsWith('/') || /\s/u.test(trimmed)) return trimmed;

  if (commands.some((command) => command.name === trimmed)) return trimmed;
  const [only, ...more] = filterCommands(commands, trimmed);

  return only !== undefined && more.length === 0 ? only.name : trimmed;
}
