/**
 * Shape of a single x402-priced API entry in the registry.
 *
 * Same schema for `seed.json` (curated, verified) and `seed.candidates.json`
 * (watchlist; `verified: false`). The `verify-seed` script (M3b) promotes
 * candidates to seed.json after a successful 402 round-trip.
 *
 * Adding a new entry is a single PR — see docs/adding-an-api.md.
 */

export type RegistryEntry = {
  /** Stable kebab-case id, unique within the registry. */
  id: string;
  /** Short human-readable name (≤80 chars). */
  name: string;
  /** What the API does. 1-2 sentences. */
  description: string;
  /** Full URL of the priced endpoint. May contain `{param}` placeholders for path templating. */
  endpoint: string;
  method: 'GET' | 'POST';
  /** Price in USDC, decimal (e.g. 0.005 = half a cent). Humans read this. */
  price_usdc: number;
  /** Price in atomic USDC units (6 decimals). Programs read this. Must equal price_usdc * 1e6. */
  price_atomic: number;
  /** Short chain id used in logs/receipts (e.g. "base"). */
  chain: string;
  /** CAIP-2 chain id used by x402 (e.g. "eip155:8453"). */
  network: string;
  /**
   * Which handshake protocol this seller speaks. `x402` (Coinbase / Linux
   * Foundation) handles both EVM and Solana; `mpp` (paymentauth.org
   * draft-solana-charge) is Solana-only. Defaults to `x402` if absent, since
   * the field was added in v0.5.0 alongside MPP support — older entries
   * predate the field and were all x402.
   */
  protocol?: 'x402' | 'mpp';
  /** Free-text category for grouping in the UI. */
  category: string;
  /** Lowercase keywords for query matching. Be generous. */
  tags: string[];
  /** Optional concrete example URL with sample query params. */
  example?: string;
  /** True if a real call has succeeded against this endpoint. */
  verified: boolean;
  /** ISO date (YYYY-MM-DD) of last successful verification. */
  verified_at: string;
  /**
   * Where this entry came from. `verified` for hand-curated `seed.json`,
   * `candidate` for `seed.candidates.json`, or an external-source id for
   * federated entries. Surfaced in `x402.discover` results so the agent
   * (and the user) can weigh trust accordingly.
   */
  source?:
    | 'verified'
    | 'candidate'
    | 'cdp-bazaar'
    | 'agentic-market'
    | 'x402watch'
    | '402directory';
};

export type RegistryFile = {
  version: 1;
  /** Optional free-text note (JSON has no comments). */
  _note?: string;
  entries: RegistryEntry[];
};
