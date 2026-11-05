/** Tab-level boundary: contains render throws and reports each caught error once via `client-error/report.ts`. */

import { Component, useEffect, type ReactNode, type ErrorInfo } from "react";
import { pageDeployedBuildSha, reportRenderFailure, routeTemplateOf } from "@kinu.run/core";
import { chainOf, detach, diagnostics } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";
import { Effect } from "effect";

interface Props {
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Where in the tree it was thrown, once React has said. */
  componentStack: string | null;
}

/** Reports a caught render failure once it is on screen, if `claim` says it is not yet reported: only a reporter defect
 *  can fail here, and it is recorded rather than raised onto a failed page. */
function FailureReport({ error, componentStack, claim }: { error: Error; componentStack: string; claim: (error: Error) => boolean }) {
  useEffect(() => {
    if (!claim(error)) return;
    detach(Effect.catchCause(Effect.promise(() => reportRenderFailure(error, componentStack, {
      release: pageDeployedBuildSha(),
      route: routeTemplateOf(location.pathname),
    })), (failed) => Effect.sync(() => {
      diagnostics.event('client_error.reporter_failed', { reason: chainOf(failed) });
    })));
  }, [error, componentStack, claim]);

  return null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  /** Already-reported error, by identity: React's retries rethrow the same object.
   *  Per instance, so two failing boundaries report two faults. */
  private reported: Error | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  /** The tree's stack, for the report. */
  componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  /** Whether this error is this boundary's to report: React's retries rethrow the same object, and a report that ran
   *  twice (StrictMode's second effect) claims it once. */
  claim = (error: Error): boolean => {
    if (this.reported === error) return false;
    this.reported = error;

    return true;
  };

  reset = () => this.setState({ error: null, componentStack: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="h-full overflow-y-auto flex items-start justify-center p-6">
        {this.state.componentStack !== null && <FailureReport error={this.state.error} componentStack={this.state.componentStack} claim={this.claim} />}
        <div className="max-w-2xl w-full text-left space-y-3">
          <div data-failure className="t-item p-text">
            This view crashed{this.props.label ? ` (${this.props.label})` : ''}. Try again, or reload the page.
          </div>
          <Surface look="tile" className="t-meta t-mono p-text-3 break-words p-3 border p-border text-left">
            {this.state.error.message || String(this.state.error)}
          </Surface>
          <Button variant="secondary" size="sm" onClick={this.reset}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
