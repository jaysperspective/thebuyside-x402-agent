import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapPolicy, DEFAULT_CAPS } from '../src/policy/caps.js';
import { Receipts } from '../src/policy/receipts.js';

describe('CapPolicy', () => {
  let dir: string;
  let receipts: Receipts;
  let caps: CapPolicy;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tbs-caps-'));
    receipts = new Receipts(join(dir, 'r.jsonl'));
    caps = new CapPolicy(DEFAULT_CAPS, receipts);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('allows a payment within both caps', async () => {
    const decision = await caps.check(5000n); // $0.005
    expect(decision.ok).toBe(true);
  });

  it('rejects a payment that exceeds the per-call cap', async () => {
    const decision = await caps.check(60_000n); // $0.06 > $0.05 default
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/per-call cap/);
    }
  });

  it('rejects a payment that would push daily total over the cap', async () => {
    // Pre-record $0.998 of receipts.
    for (let i = 0; i < 200; i++) {
      await receipts.record({
        host: 'a',
        url: 'a',
        method: 'GET',
        amount_atomic: '4990', // 200 * 4990 = 998000 = $0.998
        asset: 'USDC',
        chain: 'base',
        tx_hash: null,
      });
    }

    // $0.005 more would push us to $1.003, over the $1.00 default daily cap.
    const decision = await caps.check(5000n);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/daily cap/);
      expect(decision.spentSoFarAtomic).toBe(998_000n);
    }
  });

  it('rejects zero or negative amounts', async () => {
    expect((await caps.check(0n)).ok).toBe(false);
    expect((await caps.check(-1n)).ok).toBe(false);
  });

  it('honors custom config', async () => {
    const tight = new CapPolicy(
      { perCallLimitAtomic: 1000n, dailyLimitAtomic: 2000n, killSwitch: false },
      receipts,
    );
    expect((await tight.check(500n)).ok).toBe(true);
    expect((await tight.check(1500n)).ok).toBe(false); // over per-call
  });

  it('killSwitch refuses everything regardless of amount', async () => {
    const off = new CapPolicy(
      { perCallLimitAtomic: 1_000_000n, dailyLimitAtomic: 10_000_000n, killSwitch: true },
      receipts,
    );
    const d = await off.check(1n);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/KILL_SWITCH/);
  });

  it('reports spent total even when within budget', async () => {
    await receipts.record({
      host: 'a',
      url: 'a',
      method: 'GET',
      amount_atomic: '5000',
      asset: 'USDC',
      chain: 'base',
      tx_hash: null,
    });
    expect(await caps.spentTodayAtomic()).toBe(5000n);
  });
});
