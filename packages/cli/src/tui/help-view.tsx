import type { AgentClientStatus } from '../agent-client';
import { renderStatusLines } from '../slash-commands';
import { useTuiTheme } from './theme';
import type { KeybindingRegistry, TuiActionId } from './actions';

export function composerHelp(registry: KeybindingRegistry): string {
  const actions: Array<readonly [TuiActionId, string]> = [
    ['editor.submit', 'Send'],
    ['editor.newline', 'New line'],
    ['editor.history-previous', 'Previous prompt at first line'],
    ['editor.history-next', 'Next prompt at last line'],
    ['editor.history-search', 'Search prompt history'],
    ['editor.clear', 'Save and clear draft; interrupt when empty'],
    ['editor.undo', 'Undo draft edit'],
    ['editor.external', 'Edit draft in VISUAL or EDITOR'],
    ['history.line-up', 'Scroll transcript up'],
    ['history.line-down', 'Scroll transcript down'],
    ['history.page-up', 'Page transcript up'],
    ['history.page-down', 'Page transcript down'],
    ['consent.once', 'Approval: allow once'],
    ['consent.always', 'Approval: remember grant'],
    ['consent.deny', 'Approval: deny'],
    ['palette.toggle', 'Command palette'],
    ['workspace.toggle', 'Show or hide workspaces'],
    ['model.open', 'Model picker'],
    ['hub.agents', 'Agent Hub'],
    ['settings.toggle', 'Settings'],
  ];

  return ['Keyboard', ...actions.map(([action, label]) => `  ${registry.bindingsFor(action).join(' / ')}  ${label}`)].join('\n');
}

export function StatusView({ status }: { status: AgentClientStatus }) {
  const { colors } = useTuiTheme();

  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <strong fg={colors.intent.accentStrong}>Workspace status</strong>
        {renderStatusLines(status).map((line) => {
          const [label = '', ...value] = line.split(/\s+/);

          return (
            <span key={label}>
              {'\n'}
              <span fg={colors.text.muted}>  {label.padEnd(10)}</span>
              <span fg={colors.text.primary}>{value.join(' ')}</span>
            </span>
          );
        })}
      </text>
    </box>
  );
}
