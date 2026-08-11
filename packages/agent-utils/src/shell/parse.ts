import { parse as shellParse } from "shell-quote";

export interface ParsedCommand {
	argv: string[];
	stdin?: string;
}

export interface ParsedPipeline {
	commands: ParsedCommand[];
	redirect?: { type: ">" | ">>"; path: string };
	suppressErrors?: boolean;
}

export type ListOperator = "&&" | "||" | ";";

export interface ParsedCommandList {
	segments: Array<{
		pipeline: ParsedPipeline;
		operator: ListOperator | null;
	}>;
}

export function parseCommandList(input: string): ParsedCommandList {
	const cleaned = input.replace(/\s+2>\s*\/dev\/null/g, " __SUPPRESS_ERRORS__ ");
	const entries = shellParse(cleaned);
	const segments: ParsedCommandList["segments"] = [];
	let pipelineTokens: Array<string | { op: string } | { pattern?: string }> = [];

	function flushPipeline(operator: ListOperator | null): void {
		if (pipelineTokens.length === 0) return;
		const pipeline = buildPipeline(pipelineTokens);
		segments.push({ pipeline, operator });
		pipelineTokens = [];
	}

	for (const entry of entries) {
		if (typeof entry === "object" && "op" in entry) {
			if (entry.op === "&&" || entry.op === "||") {
				flushPipeline(entry.op as ListOperator);
				continue;
			}
			if (entry.op === ";") {
				flushPipeline(";");
				continue;
			}
		}
		pipelineTokens.push(entry as string | { op: string } | { pattern?: string });
	}

	flushPipeline(null);
	if (segments.length === 0) throw new Error("Empty command");
	return { segments };
}

function buildPipeline(tokens: Array<string | { op: string } | { pattern?: string }>): ParsedPipeline {
	const commands: ParsedCommand[] = [];
	let current: string[] = [];
	let redirect: ParsedPipeline["redirect"] = undefined;
	let suppressErrors = false;

	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		if (typeof entry === "string") {
			if (entry === "__SUPPRESS_ERRORS__") {
				suppressErrors = true;
				continue;
			}
			current.push(entry);
			continue;
		}
		if ("op" in entry) {
			if (entry.op === "|") {
				if (current.length) commands.push({ argv: current });
				current = [];
			} else if (entry.op === ">" || entry.op === ">>") {
				if (current.length) commands.push({ argv: current });
				current = [];
				const remaining = tokens.slice(i + 1);
				const target = remaining.find((e) => typeof e === "string") as string | undefined;
				if (!target) throw new Error("Redirect requires a target file path");
				redirect = { type: entry.op as ">" | ">>", path: target };
				break;
			}
		}
		if (typeof entry === "object" && "pattern" in entry) {
			current.push((entry as { pattern?: string }).pattern ?? String(entry));
		}
	}

	if (current.length) commands.push({ argv: current });
	if (commands.length === 0) throw new Error("Empty command in pipeline");
	return { commands, redirect, suppressErrors };
}
