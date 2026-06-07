/**
 * Spend caps — per-call and sliding-24-hour daily limits.
 *
 * Both limits are atomic USDC (`bigint`, 6 decimals). Defaults are deliberately
 * conservative for v0 ("safe out-of-the-box"). Override via env:
 *   X402_PER_CALL_LIMIT=0.05      (USDC, decimal) or 50000 (atomic units)
 *   X402_DAILY_LIMIT=1.00          ditto
 *   X402_KILL_SWITCH=1             refuse ALL payments regardless of caps
 */

import { formatUsdcAtomic, parseUsdcLimit } from './format.js';
import type { Receipts } from './receipts.js';

export type CapConfig = {
  perCallLimitAtomic: bigint;
  dailyLimitAtomic: bigint;
  killSwitch: boolean;
};

export const DEFAULT_CAPS: CapConfig = {
  perCallLimitAtomic: 50_000n, // $0.05
  dailyLimitAtomic: 1_000_000n, // $1.00
  killSwitch: false,
};

export type CapDecision =
  | { ok: true }
  | { ok: false; reason: string; spentSoFarAtomic: bigint };

export class CapPolicy {
  constructor(
    public readonly config: CapConfig,
    private readonly receipts: Receipts,
  ) {}

  static fromEnv(receipts: Receipts): CapPolicy {
    return new CapPolicy(
      {
        perCallLimitAtomic: process.env.X402_PER_CALL_LIMIT
          ? parseUsdcLimit(process.env.X402_PER_CALL_LIMIT)
          : DEFAULT_CAPS.perCallLimitAtomic,
        dailyLimitAtomic: process.env.X402_DAILY_LIMIT
          ? parseUsdcLimit(process.env.X402_DAILY_LIMIT)
          : DEFAULT_CAPS.dailyLimitAtomic,
        killSwitch: process.env.X402_KILL_SWITCH === '1',
      },
      receipts,
    );
  }

  /**
   * Check whether a payment of `amountAtomic` is allowed under both caps.
   * Returns `{ ok: true }` if allowed, otherwise an explanatory reason.
   */
  async check(amountAtomic: bigint): Promise<CapDecision> {
    if (this.config.killSwitch) {
      return {
        ok: false,
        reason:
          'X402_KILL_SWITCH=1 — all payments are disabled. ' +
          'Unset the env var and restart the gateway to resume.',
        spentSoFarAtomic: 0n,
      };
    }
    if (amountAtomic <= 0n) {
      return {
        ok: false,
        reason: `payment amount must be positive, got ${amountAtomic}`,
        spentSoFarAtomic: 0n,
      };
    }
    if (amountAtomic > this.config.perCallLimitAtomic) {
      return {
        ok: false,
        reason:
          `payment of $${formatUsdcAtomic(amountAtomic)} exceeds per-call cap of ` +
          `$${formatUsdcAtomic(this.config.perCallLimitAtomic)} (set X402_PER_CALL_LIMIT to raise)`,
        spentSoFarAtomic: 0n,
      };
    }
    const spent = await this.receipts.spentSinceHours(24);
    if (spent + amountAtomic > this.config.dailyLimitAtomic) {
      return {
        ok: false,
        reason:
          `payment of $${formatUsdcAtomic(amountAtomic)} would exceed daily cap ` +
          `(already spent $${formatUsdcAtomic(spent)} of $${formatUsdcAtomic(this.config.dailyLimitAtomic)} ` +
          `in the last 24h; set X402_DAILY_LIMIT to raise)`,
        spentSoFarAtomic: spent,
      };
    }
    return { ok: true };
  }

  async spentTodayAtomic(): Promise<bigint> {
    return this.receipts.spentSinceHours(24);
  }
}
