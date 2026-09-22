/** Tab-level boundary: contains render throws and reports each caught error once via `client-error/report.ts`. */

import { Component, type ReactNode, type ErrorInfo } from "react";
import { pageDeployedBuildSha, reportRenderFailure, routeTemplateOf } from "@kinu.run/core";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";

interface Props {
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

interface ReportOperation {
  promise: Promise<void> | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  /** Already-reported error, by identity: React's retries rethrow the same object.
   *  Per instance, so two failing boundaries report two faults. */
  private reported: Error | null = null;

  private readonly reportOperations = new Map<Error, ReportOperation>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.reported === error) return;
    this.reported = error;
    const owner: ReportOperation = { promise: null };
    this.reportOperations.set(error, owner);
    owner.promise = (async () => {
      try {
        await reportRenderFailure(error, info.componentStack ?? "", {
          release: await pageDeployedBuildSha(),
          route: routeTemplateOf(location.pathname),
        });
      } catch (cause) {
        // Only a reporter defect can reject here; record it rather than raise onto a failed page.
        diagnostics.event('client_error.reporter_failed', {
          reason: renderThrownChain({ cause }),
        });
      } finally {
        if (this.reportOperations.get(error) === owner) this.reportOperations.delete(error);
      }
    })();
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="h-full overflow-y-auto flex items-start justify-center p-6">
        <div className="max-w-2xl w-full text-left space-y-3">
          <div className="text-sm font-medium p-text">
            This view crashed{this.props.label ? ` (${this.props.label})` : ''}. Try again, or reload the page.
          </div>
          <div className="text-xs p-text-3 font-mono break-words p-fill rounded-sm p-3 border p-border text-left">
            <div className="font-bold mb-2">{this.state.error.message || String(this.state.error)}</div>
            {this.state.error.stack && (
              <pre className="p-annotation whitespace-pre-wrap opacity-70">{this.state.error.stack}</pre>
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
