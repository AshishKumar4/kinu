import type { SqlValue } from "../types";
import * as v from "valibot";

/** Concatenate multiple Uint8Array chunks into a single Uint8Array. */
export function concatBuffers(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 0) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0];

	const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/**
 * Convert SQL row data to Uint8Array.
 * Handles ArrayBuffer (Cloudflare DO storage.sql BLOBs), Uint8Array (bun:sqlite
 * BLOBs), string (legacy base64 from v1 schema), and null.
 */
export function rowDataToBytes(data: SqlValue | Uint8Array | undefined): Uint8Array {
	if (data == null) return new Uint8Array(0);
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	const stringData = v.safeParse(v.string(), data);
	if (stringData.success) {
		// Legacy base64-encoded data from v1 schema
		const binary = atob(stringData.output);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}
	return new Uint8Array(0);
}

/** Return an exact-sized ArrayBuffer, independent of the input view. */
export function toBuffer(data: Uint8Array): ArrayBuffer {
	return Uint8Array.from(data).buffer;
}
