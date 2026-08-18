import { deleteAliasShim, loadConfigFile, pathHint, resolveAgentRef, writeAliasShim } from '../config';
import { ACCENT, DIM, OK } from '../display';

export async function aliasCommand(agentName: string, aliasName: string | undefined): Promise<void> {
  const agent = resolveAgentRef(agentName);
  const canonical = agent?.name ?? agentName;
  const alias = aliasName ?? canonical;
  const path = writeAliasShim(canonical, alias);
  console.log(`${OK('✓')} ${ACCENT(alias)} ${DIM('→')} ${ACCENT(canonical)} ${DIM(path)}`);
  const hint = pathHint();
  if (hint) console.log(DIM(hint));
}

export async function unaliasCommand(aliasName: string): Promise<void> {
  deleteAliasShim(aliasName);
  console.log(`${OK('✓')} Removed alias ${ACCENT(aliasName)}`);
}

export async function aliasesCommand(): Promise<void> {
  const aliases = loadConfigFile().aliases ?? {};
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    console.log(DIM('No aliases configured.'));
    return;
  }
  for (const [alias, agent] of entries) {
    console.log(`${ACCENT(alias)} ${DIM('→')} ${agent}`);
  }
}
