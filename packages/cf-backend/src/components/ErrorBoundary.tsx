/**
 * Tab-level ErrorBoundary.
 *
 * Without this, a render-time throw anywhere in a tab (Markdown parse error,
 * d3 bug in MCTS tree, malformed message, …) crashes the entire workspace
 * page. Wrapping each tab in a boundary contains the blast radius — the
 * other tabs and the chat panel keep working, and the user sees a clear
 * recovery action. (STABILITY-AUDIT §D2.)
 */

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  /** Human-readable label for the failing region — surfaced in the fallback. */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to console for debugging without spamming the UI; production
    // builds get the same stack via the browser's existing error reporting.
    console.error(`[ErrorBoundary:${this.props.label ?? "unknown"}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full overflow-y-auto flex items-start justify-center p-6">
        <div className="max-w-2xl w-full text-left space-y-3">
          <div className="text-sm font-medium p-text">
            Something went wrong rendering this view{this.props.label ? ` (${this.props.label})` : ''}.
          </div>
          <div className="text-xs p-text-3 font-mono break-words p-fill rounded p-3 border p-border text-left">
            <div className="font-bold mb-2">{this.state.error.message || String(this.state.error)}</div>
            {this.state.error.stack && (
              <pre className="text-[10px] whitespace-pre-wrap opacity-70">{this.state.error.stack}</pre>
            )}
          </div>
          <button
            onClick={this.reset}
            className="text-xs px-3 py-1.5 rounded-md p-fill border p-border hover:p-text"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
