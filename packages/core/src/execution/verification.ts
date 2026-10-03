import { hmacSha256Hex } from '../utils/crypto';

const randomUUID = crypto.randomUUID.bind(crypto);

export function verificationToken(): string {
  return `KINU_VERIFY_${randomUUID()}`;
}

export async function verificationReceipt(token: string, payload: string): Promise<string> {
  return `KINU_VERIFY_${await hmacSha256Hex(token, payload)} ${payload}`;
}

export async function verifiedPayload(output: string, token: string): Promise<string | null> {
  const receipts = output.split(/\r?\n/).filter((line) => /^KINU_VERIFY_[0-9a-f]{64} /.test(line));
  const verified: string[] = [];

  for (const receipt of receipts) {
    const payload = receipt.slice(receipt.indexOf(' ') + 1);

    if (receipt === await verificationReceipt(token, payload)) verified.push(payload);
  }

  return verified.length === 1 ? verified[0] : null;
}
