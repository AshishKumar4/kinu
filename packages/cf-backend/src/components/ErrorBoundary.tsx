/**
 * Tab-level ErrorBoundary.
 *
 * Without this, a render-time throw anywhere in a tab (Markdown parse error,
 * d3 bug in MCTS tree, malformed message, …) crashes the entire workspace
 * page. Wrapping each tab in a boundary contains the blast radius — the
 * other tabs and the chat panel keep working, and the user sees a clear
 * recovery action. (STABILITY-AUDIT §D2.)
 *
 * It also REPORTS. What it used to do instead was write the error to `console`
 * under a comment claiming "production builds get the same stack via the
 * browser's existing error reporting"; no such reporting existed, so a
 * whitescreened view in front of a user produced no line anywhere an operator
 * reads. `client-error/report.ts` sends one bounded, same-origin report per
 * caught error, and `client-error/route.ts` writes it to Workers Logs against
 * the build the page was running. The console line is gone rather than kept
 * beside it: the fallback below already renders the message and the stack on
 * screen, so a developer loses nothing, and one destination is easier to trust
 * than two.
 */

import { Component, type ReactNode, type ErrorInfo } from "react";
import { reportRenderFailure } from "@/client-error/report";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";

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

  /**
   * The error this boundary has already reported.
   *
   * Identity rather than a signature: React hands `componentDidCatch` the very
   * object that was thrown, so the duplicate this guards against — one error
   * reaching one boundary twice as React unwinds and retries the render — is the
   * same reference. A genuinely new throw is a new object and earns a new
   * report, which is what tells an operator a fault is recurring.
   *
   * INSTANCE state, deliberately: not a module-level set and nothing persisted.
   * Two boundaries failing on one page are two faults and both are worth
   * knowing, and a reload is a new page whose faults are new facts.
   */
  private reported: Error | null = null;

  private readonly reportOperations = new Map<Error, Promise<void>>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.reported === error) return;
    this.reported = error;
    let report: Promise<void> | null = null;
    report = (async () => {
      try {
        // The fallback is already on screen — React set this boundary's state
        // before calling here — so this instance owns the report until it settles.
        await undefined;
        await reportRenderFailure(error, info.componentStack ?? "");
      } catch (cause) {
        // The only rejection left is a defect in the reporter itself (its fetch
        // catch rethrows non-transport failures on purpose). Swallowing it here
        // would be a silent drop inside the one handler whose job is to report,
        // so it is recorded rather than raised onto a page that already has one.
        diagnostics.event('client_error.reporter_failed', {
          reason: renderThrownChain({ cause }),
        });
      } finally {
        if (this.reportOperations.get(error) === report) this.reportOperations.delete(error);
      }
    })();
    this.reportOperations.set(error, report);
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
          <div className="text-xs p-text-3 font-mono break-words p-fill rounded-sm p-3 border p-border text-left">
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
