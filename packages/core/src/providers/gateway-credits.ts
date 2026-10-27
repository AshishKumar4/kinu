/**
 * An account's AI Gateway credits: what pays for searches through Cloudflare's Web Search API, and for other providers'
 * models billed through the gateway (Unified Billing). Cloudflare's API only reads them: credits are bought, and auto
 * top-up is set, on its dashboard (AI Gateway › Credits Available › Manage), with a 5% fee on each purchase (Cloudflare's
 * Unified Billing docs and API reference, read 2026-10-27).
 */
import * as v from 'valibot';

export interface GatewayCredits {
  /** US dollars; below zero once spending ran past them. */
  readonly balance: number;
  /** Whether Cloudflare holds a card to buy them with. */
  readonly card: boolean;
  /** Null: auto top-up is off. */
  readonly autoTopUp: { readonly threshold: number; readonly amount: number } | null;
}

export const GatewayCreditsSchema: v.GenericSchema<GatewayCredits> = v.object({
  balance: v.number(),
  card: v.boolean(),
  autoTopUp: v.nullable(v.object({ threshold: v.number(), amount: v.number() })),
});

/** Cloudflare's answer, as kinu.run's account read it on 2026-10-27: `topup_config` holds zeros while auto top-up is off. */
export const CreditBalanceSchema = v.object({
  balance: v.number(),
  has_default_payment_method: v.boolean(),
  topup_config: v.nullish(v.object({ threshold: v.number(), amount: v.number() })),
});

export function creditsOf(read: v.InferOutput<typeof CreditBalanceSchema>): GatewayCredits {
  const topUp = read.topup_config;

  return {
    balance: read.balance,
    card: read.has_default_payment_method,
    autoTopUp: topUp === null || topUp === undefined || topUp.amount <= 0 ? null : { threshold: topUp.threshold, amount: topUp.amount },
  };
}

/** Readable with AI Gateway Read or Write, and with the `aig.write` OAuth scope. */
export function creditBalancePath(account: string): string {
  return `/accounts/${account}/ai-gateway/billing/credit-balance`;
}

/** Where `account`'s credits are bought and its auto top-up is set. */
export function gatewayCreditsUrl(account: string): string {
  return `https://dash.cloudflare.com/${account}/ai/ai-gateway`;
}

/** Who pays for an account's searches through Cloudflare, and what they have left: its own connected account, or the
 *  deployment's, which only the deployment's operators are shown. */
export interface GatewayCreditsRead {
  readonly payer: 'yours' | 'deployment';
  readonly account: string;
  readonly credits: GatewayCredits;
}

export const GatewayCreditsReadSchema: v.GenericSchema<GatewayCreditsRead> = v.object({
  payer: v.picklist(['yours', 'deployment']),
  account: v.string(),
  credits: GatewayCreditsSchema,
});
