/** The terminal client's presentation, off the root barrel so the Worker loads none of it. */
export {
  CHANGE_KIND_GLYPH,
  composerVisibleRows,
  TUI_ADVERTISED_PRESET_BINDINGS,
  TUI_ADVERTISED_HINTS,
  TUI_COMPOSER_PLACEHOLDER,
  TUI_COMPOSER_STEERING_PLACEHOLDER,
  TUI_MARKS,
} from '../tui-presentation';

export { modelDisplayName, formatContextUsage } from './context-status';

export { clipText, terminalText, literalText, agentDisplayLabel } from './format';

export { renderChangelogText } from './changelog-text';
