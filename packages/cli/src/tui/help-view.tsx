/**
 * Help and slash-command result views rendered in the TUI.
 */

import type { AgentInfo } from '@proteus/core';

export function HelpView() {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <strong fg="#c4b5fd">Commands</strong>{'\n'}
        <span fg="#6b7280">  /help     </span><span fg="#d1d5db">Show this help</span>{'\n'}
        <span fg="#6b7280">  /status   </span><span fg="#d1d5db">Agent state and stats</span>{'\n'}
        <span fg="#6b7280">  /tools    </span><span fg="#d1d5db">List available tools</span>{'\n'}
        <span fg="#6b7280">  /model    </span><span fg="#d1d5db">Show or set the active model</span>{'\n'}
        <span fg="#6b7280">  /models   </span><span fg="#d1d5db">List configured providers</span>{'\n'}
        <span fg="#6b7280">  /memory   </span><span fg="#d1d5db">Show memory contents</span>{'\n'}
        <span fg="#6b7280">  /tree     </span><span fg="#d1d5db">Show MCTS search tree</span>{'\n'}
        <span fg="#6b7280">  /always   </span><span fg="#d1d5db">Pin always-active skills</span>{'\n'}
        <span fg="#6b7280">  /approval </span><span fg="#d1d5db">Shell approval mode</span>{'\n'}
        <span fg="#6b7280">  /exit     </span><span fg="#d1d5db">Exit chat</span>
      </text>
    </box>
  );
}

export function StatusView({ info, dbSize }: { info: AgentInfo; dbSize: number }) {
  const kb = (dbSize / 1024).toFixed(1);
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <strong fg="#c4b5fd">Agent Status</strong>{'\n'}
        <span fg="#6b7280">  Name:      </span><span fg="#e2e8f0">{info.name}</span>{'\n'}
        <span fg="#6b7280">  ID:        </span><span fg="#6b7280">{info.id.slice(0, 12)}…</span>{'\n'}
        <span fg="#6b7280">  Purpose:   </span><span fg="#d1d5db">{info.purpose.slice(0, 60)}</span>{'\n'}
        <span fg="#6b7280">  Scaffold:  </span><span fg="#e2e8f0">v{info.scaffoldVersion}</span>{'\n'}
        <span fg="#6b7280">  MCTS:      </span><span fg="#e2e8f0">{info.searchNodeCount} nodes</span>{'\n'}
        <span fg="#6b7280">  Tasks:     </span><span fg="#e2e8f0">{info.taskCount}</span>{'\n'}
        <span fg="#6b7280">  Tools:     </span><span fg="#e2e8f0">6 built-in + {info.craftedToolCount} crafted</span>{'\n'}
        <span fg="#6b7280">  Memory:    </span><span fg="#e2e8f0">{info.memorySize} B</span>{'\n'}
        <span fg="#6b7280">  Database:  </span><span fg="#e2e8f0">{kb} KB</span>
      </text>
    </box>
  );
}
