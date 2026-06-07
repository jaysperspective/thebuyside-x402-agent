/**
 * verify-seed — assert each entry in `src/registry/seed.json` is still
 * x402-priced and returns the price the registry advertises.
 *
 * For each entry:
 *   1. GET the example URL (or endpoint if no example) — expect 402.
 *   2. parseChallenge — handles both v1 (body) and v2 (header) transports.
 *   3. Find an `exact`-scheme accept matching the entry's network.
 *   4. Assert the advertised amount matches `entry.price_atomic`.
 *
 * Designed for CI (.github/workflows/verify-seed.yml). Exit non-zero on
 * any failure. Templated endpoints (with `{placeholder}`) require an
 * example URL — otherwise the entry is skipped with a clear warning.
 */

import { Registry } from '../src/registry/lookup.js';
import type { RegistryEntry } from '../src/registry/types.js';
import { parseChallenge } from '../src/x402/client.js';

type CheckResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

async function verifyEntry(entry: RegistryEntry): Promise<CheckResult> {
  const url = entry.example ?? entry.endpoint;
  if (url.includes('{')) {
    return {
      ok: false,
      detail:
        'endpoint contains unresolved {placeholder} and entry has no `example` URL',
    };
  }

  let response: Response;
  try {
    response = await fetch(url, { method: entry.method });
  } catch (err) {
    return { ok: false, detail: `fetch failed: ${err instanceof Error ? err.message : err}` };
  }

  if (response.status !== 402) {
    return { ok: false, detail: `expected 402, got ${response.status}` };
  }

  let challenge;
  try {
    challenge = await parseChallenge(response);
  } catch (err) {
    return {
      ok: false,
      detail: `parseChallenge failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  const reqs = challenge.accepts.find(
    (a) => a.scheme === 'exact' && a.network === entry.network,
  );
  if (!reqs) {
    return {
      ok: false,
      detail:
        `no exact-scheme accept matching network "${entry.network}". ` +
        `Got: ${challenge.accepts.map((a) => `${a.scheme}/${a.network}`).join(', ')}`,
    };
  }

  const expected = String(entry.price_atomic);
  if (reqs.maxAmountRequired !== expected) {
    return {
      ok: false,
      detail: `price mismatch: registry says ${expected} atomic, server says ${reqs.maxAmountRequired}`,
    };
  }

  return {
    ok: true,
    detail: `${reqs.maxAmountRequired} atomic → ${reqs.payTo} (x402 v${challenge.x402Version})`,
  };
}

async function main(): Promise<void> {
  const registry = await Registry.load();
  console.log(`verify-seed: checking ${registry.entries.length} entries\n`);

  if (registry.entries.length === 0) {
    console.log(
      'seed.json is empty — discovery now federates live via 402directory.com ' +
        'and other indexes (see Federation.fromEnv). Nothing to verify; exiting OK.',
    );
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;

  for (const entry of registry.entries) {
    process.stdout.write(`  ${entry.id.padEnd(32)} `);
    const result = await verifyEntry(entry);
    if (result.ok) {
      console.log(`✓ ${result.detail}`);
      passed += 1;
    } else {
      console.log(`✗ ${result.detail}`);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('verify-seed: unexpected error:', err);
  process.exit(1);
});
