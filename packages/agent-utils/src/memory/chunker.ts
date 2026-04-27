export const DEFAULT_CHUNK_TARGET_CHARS = 1600;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 320;

export interface Chunk {
	text: string;
	startLine: number;
	endLine: number;
	hash: string;
}

async function hashText(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const buf = await crypto.subtle.digest("SHA-256", data);
	const arr = new Uint8Array(buf);
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Line-aware sliding window chunking, matching OpenClaw's algorithm. */
export async function chunkMarkdown(
	content: string,
	targetChars = DEFAULT_CHUNK_TARGET_CHARS,
	overlapCharSize = DEFAULT_CHUNK_OVERLAP_CHARS,
): Promise<Chunk[]> {
	const lines = content.split("\n");
	const maxChars = Math.max(32, targetChars);
	const overlapChars = Math.max(0, overlapCharSize);

	const chunks: Chunk[] = [];
	let current: Array<{ line: string; lineNo: number }> = [];
	let currentChars = 0;

	const flushChunk = async () => {
		if (current.length === 0) return;
		const text = current.map((e) => e.line).join("\n");
		const startLine = current[0].lineNo;
		const endLine = current[current.length - 1].lineNo;
		const hash = await hashText(text);
		chunks.push({ text, startLine, endLine, hash });
	};

	const carryOverlap = () => {
		if (overlapChars <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept: Array<{ line: string; lineNo: number }> = [];
		for (let i = current.length - 1; i >= 0; i--) {
			const entry = current[i];
			acc += entry.line.length + 1;
			kept.unshift(entry);
			if (acc >= overlapChars) break;
		}
		current = kept;
		currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLen = line.length + 1;

		if (currentChars + lineLen > maxChars && current.length > 0) {
			await flushChunk();
			carryOverlap();
		}

		current.push({ line, lineNo: i + 1 });
		currentChars += lineLen;
	}

	// Flush remaining
	await flushChunk();

	return chunks;
}
