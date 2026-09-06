import { type JsonValue } from "../../core/index.js";
import type { TerminalOutcome } from "./generated/turn-status/AgentCore/Extract/TurnStatus.js";
export type { TerminalOutcome };
export declare function requireTerminalOutcome(value: JsonValue | undefined, subject: string): TerminalOutcome;
