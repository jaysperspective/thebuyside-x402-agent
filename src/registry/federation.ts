/**
 * Federation — query external x402 indexes (CDP Bazaar, agentic.market,
 * x402watch) in parallel and merge results into the local seed.json corpus.
 *
 * Why federate at runtime: the x402 ecosystem is growing faster than a
 * hand-curated `seed.json` can keep up with. External indexes already
 * crawl/list thousands of endpoints. We let the user opt in to live
 * federation and tag every returned entry with its `source` so the agent
 * (and the user, via the discover output) can weigh trust accordingly.
 *
 * Robustness: every external source is wrapped in a per-source timeout +
 * try/catch. A slow, broken, or 404-ing source produces zero entries and
 * a logged warning — never a thrown error and never a blocked discover
 * call. If all three sources are down the user still gets seed.json hits.
 *
 * URL defaults below were verified against live endpoints on 2026-05-10.
 * They can be overridden per-source via `X402_BAZAAR_URL` /
 * `X402_AGENTIC_URL` / `X402_X402WATCH_URL`. A source with an unset URL
 * is silently disabled.
 */

import { gunzipSync } from 'node:zlib';
import { logger } from '../log.js';
import type { RegistryEntry } from './types.js';

export type ExternalSourceId =
  | 'cdp-bazaar'
  | 'agentic-market'
  | 'x402watch'
  | '402directory';

export type FetchContext = {
  signal: AbortSignal;
  fetchFn: typeof fetch;
};

export interface ExternalSource {
  id: ExternalSourceId;
  name: string;
  fetch(query: string, ctx: FetchContext): Promise<RegistryEntry[]>;
}

export type FederationConfig = {
  enabled: boolean;
  timeoutMs: number;
  sources: ExternalSource[];
};

const DEFAULT_TIMEOUT_MS = 1500;

export class Federation {
  constructor(public readonly config: FederationConfig) {}

  static fromEnv(): Federation {
    const enabled = (process.env.X402_FEDERATION ?? 'on').toLowerCase() !== 'off';
    const timeoutMs = parseTimeout(process.env.X402_FEDERATION_TIMEOUT_MS);
    const sources: ExternalSource[] = [];

    if (process.env.X402_DISABLE_BAZAAR !== '1') {
      const url = process.env.X402_BAZAAR_URL ?? DEFAULT_BAZAAR_URL;
      if (url) sources.push(makeCdpBazaarSource(url));
    }
    if (process.env.X402_DISABLE_AGENTIC !== '1') {
      const url = process.env.X402_AGENTIC_URL ?? DEFAULT_AGENTIC_URL;
      if (url) sources.push(makeAgenticMarketSource(url));
    }
    if (process.env.X402_DISABLE_X402WATCH !== '1') {
      const url = process.env.X402_X402WATCH_URL ?? DEFAULT_X402WATCH_URL;
      if (url) sources.push(makeX402WatchSource(url));
    }
    if (process.env.X402_DISABLE_402DIRECTORY !== '1') {
      const url = process.env.X402_DIRECTORY_URL ?? DEFAULT_402DIRECTORY_URL;
      if (url) sources.push(make402DirectorySource(url));
    }

    return new Federation({ enabled, timeoutMs, sources });
  }

  /**
   * Fan out to every enabled source in parallel. Always resolves —
   * individual source failures are logged + swallowed. Returns entries
   * tagged with their `source` field.
   */
  async search(
    query: string,
    opts: { fetchFn?: typeof fetch } = {},
  ): Promise<RegistryEntry[]> {
    if (!this.config.enabled || this.config.sources.length === 0) return [];
    const fetchFn = opts.fetchFn ?? fetch;

    const results = await Promise.all(
      this.config.sources.map((source) => this.runSource(source, query, fetchFn)),
    );
    return results.flat();
  }

  private async runSource(
    source: ExternalSource,
    query: string,
    fetchFn: typeof fetch,
  ): Promise<RegistryEntry[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    try {
      const entries = await source.fetch(query, { signal: ctrl.signal, fetchFn });
      return entries.map((e) => ({ ...e, source: e.source ?? source.id }));
    } catch (err: unknown) {
      logger.warn('federation source failed', {
        source: source.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Source adapters.
//
// URL defaults verified against live endpoints on 2026-05-10. Each adapter
// degrades gracefully on shape changes (returns [] rather than throwing);
// the orchestrator's try/catch is the final safety net.
// ---------------------------------------------------------------------------

const DEFAULT_BAZAAR_URL =
  'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
const DEFAULT_AGENTIC_URL = 'https://api.agentic.market/v1/services/search';
/**
 * x402watch publishes daily snapshots to GitHub under CC0. The `{date}`
 * placeholder is replaced with today's UTC date at fetch time, with a
 * one-day fallback if today's snapshot hasn't been published yet.
 */
const DEFAULT_X402WATCH_URL =
  'https://raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz';
const DEFAULT_402DIRECTORY_URL = 'https://402directory.com/api/directory';

/**
 * CDP Bazaar — Coinbase's semantic-search index. Verified shape (2026-05-10):
 *   GET /platform/v2/x402/discovery/search?query=...&limit=20
 *   → { partialResults, resources: [{
 *         resource: "https://...",        // endpoint URL
 *         description: "...",
 *         accepts: [{
 *           scheme, network, asset, payTo,
 *           amount | maxAmountRequired,    // both shapes seen in the wild
 *           extra: { name, version },
 *           ...
 *         }],
 *         lastUpdated: "...",
 *         extensions: { ... }
 *       }] }
 */
export function makeCdpBazaarSource(baseUrl: string): ExternalSource {
  return {
    id: 'cdp-bazaar',
    name: 'CDP Bazaar',
    async fetch(query, { signal, fetchFn }) {
      const url = appendQuery(baseUrl, { query, limit: '20' });
      const r = await fetchFn(url, { signal });
      if (!r.ok) return [];
      const json = await r.json().catch(() => null);
      const list = (json as { resources?: unknown[] } | null)?.resources;
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => bazaarItemToEntry(item))
        .filter((e): e is RegistryEntry => e !== null);
    },
  };
}

function bazaarItemToEntry(item: unknown): RegistryEntry | null {
  const o = (item ?? {}) as Record<string, unknown>;
  const resource = typeof o.resource === 'string' ? o.resource : null;
  if (!resource) return null;

  const accepts = Array.isArray(o.accepts) ? (o.accepts as Record<string, unknown>[]) : [];
  // Prefer Base; CDP responses commonly carry both Solana and Base options
  // and v0 only signs Base. We still surface the entry if only non-Base
  // options exist — `verified: false` flags it for the user.
  const accept =
    accepts.find((a) => a.network === 'base' || a.network === 'eip155:8453') ??
    accepts[0];
  if (!accept) return null;

  const amountStr =
    (typeof accept.amount === 'string' && accept.amount) ||
    (typeof accept.maxAmountRequired === 'string' && accept.maxAmountRequired) ||
    '0';
  const atomic = Number(amountStr);
  const network = typeof accept.network === 'string' ? accept.network : '';
  const description =
    (typeof o.description === 'string' && o.description) ||
    (typeof accept.description === 'string' && accept.description) ||
    '';

  return {
    id: `bazaar-${stableId(resource)}`,
    name: safeHostname(resource) ?? resource,
    description,
    endpoint: resource,
    method: 'GET',
    price_usdc: atomic / 1_000_000,
    price_atomic: atomic,
    chain: shortChain(network),
    network,
    category: 'unknown',
    tags: [],
    verified: false,
    verified_at: '',
  };
}

/**
 * agentic.market — third-party x402 marketplace. Verified shape (2026-05-10):
 *   GET /v1/services/search?q=...
 *   → { services: [{
 *         id, name, description, category,
 *         networks: ["Base", "Solana", ...],
 *         endpoints: [{
 *           url, method, description,
 *           pricing: { amount, currency, network, scheme }
 *         }]
 *       }] }
 *
 * One service can expose multiple endpoints; we flatten to one
 * RegistryEntry per (service, endpoint) pair.
 */
export function makeAgenticMarketSource(baseUrl: string): ExternalSource {
  return {
    id: 'agentic-market',
    name: 'agentic.market',
    async fetch(query, { signal, fetchFn }) {
      const url = appendQuery(baseUrl, { q: query });
      const r = await fetchFn(url, { signal });
      if (!r.ok) return [];
      const json = await r.json().catch(() => null);
      const list = (json as { services?: unknown[] } | null)?.services;
      if (!Array.isArray(list)) return [];
      return list.flatMap((item) => agenticServiceToEntries(item));
    },
  };
}

function agenticServiceToEntries(service: unknown): RegistryEntry[] {
  const s = (service ?? {}) as Record<string, unknown>;
  const endpoints = Array.isArray(s.endpoints)
    ? (s.endpoints as Record<string, unknown>[])
    : [];
  const serviceName = typeof s.name === 'string' ? s.name : '';
  const serviceCategory = typeof s.category === 'string' ? s.category : 'unknown';
  const networks = Array.isArray(s.networks) ? (s.networks as string[]) : [];

  return endpoints
    .map((ep): RegistryEntry | null => {
      const url = typeof ep.url === 'string' ? ep.url : null;
      if (!url) return null;
      const pricing = (ep.pricing ?? {}) as Record<string, unknown>;
      const priceStr = typeof pricing.amount === 'string' ? pricing.amount : '0';
      const price = Number(priceStr);
      const epNetwork =
        typeof pricing.network === 'string' ? pricing.network : networks[0] ?? 'Base';
      const network = normalizeAgenticNetwork(epNetwork);

      return {
        id: `agentic-${stableId(url)}`,
        name: serviceName ? `${serviceName} — ${safeHostname(url) ?? ''}` : (safeHostname(url) ?? url),
        description: typeof ep.description === 'string' ? ep.description : '',
        endpoint: url,
        method: humanMethod(ep.method),
        price_usdc: Number.isFinite(price) ? price : 0,
        price_atomic: Number.isFinite(price) ? Math.round(price * 1_000_000) : 0,
        chain: shortChain(network),
        network,
        category: serviceCategory,
        tags: [serviceName.toLowerCase()].filter((t) => t.length > 0),
        verified: false,
        verified_at: '',
      };
    })
    .filter((e): e is RegistryEntry => e !== null);
}

function normalizeAgenticNetwork(name: string): string {
  const n = name.toLowerCase();
  if (n === 'base') return 'eip155:8453';
  if (n === 'base sepolia' || n === 'base-sepolia') return 'eip155:84532';
  if (n === 'solana') return 'solana';
  if (n === 'polygon') return 'eip155:137';
  if (n === 'arbitrum') return 'eip155:42161';
  return name;
}

/**
 * x402watch — wash-filtered intelligence published as daily CC0 snapshots
 * on GitHub. Not a live API: each call fetches a ~2MB gzipped JSON file
 * (today's snapshot) and filters client-side. Cached in-process by date
 * so we hit GitHub at most once per UTC day per process lifetime.
 *
 * Snapshot shape (verified 2026-05-10):
 *   { snapshot_date, schema_version, service_count, services: [{
 *       id, chain, resource_url, name, description, category,
 *       price_amount,                 // float USDC, NOT atomic
 *       organic_traffic_pct,
 *       suspected_wash_pct
 *     }] }
 */
export function makeX402WatchSource(baseUrl: string): ExternalSource {
  const cache = new Map<string, RegistryEntry[]>();

  return {
    id: 'x402watch',
    name: 'x402watch',
    async fetch(query, { signal, fetchFn }) {
      const dates = candidateDates();
      let entries: RegistryEntry[] | null = null;
      for (const date of dates) {
        const cached = cache.get(date);
        if (cached) {
          entries = cached;
          break;
        }
        const url = baseUrl.replace('{date}', date);
        const r = await fetchFn(url, { signal });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        let parsed: unknown;
        try {
          parsed = JSON.parse(gunzipSync(buf).toString('utf8'));
        } catch {
          continue;
        }
        const list = (parsed as { services?: unknown[] } | null)?.services;
        if (!Array.isArray(list)) continue;
        const mapped = list
          .map((item) => x402watchItemToEntry(item))
          .filter((e): e is RegistryEntry => e !== null);
        cache.set(date, mapped);
        entries = mapped;
        break;
      }
      if (!entries) return [];
      return entries.filter((e) => matchesQuery(e, query));
    },
  };
}

function x402watchItemToEntry(item: unknown): RegistryEntry | null {
  const o = (item ?? {}) as Record<string, unknown>;
  const endpoint = typeof o.resource_url === 'string' ? o.resource_url : null;
  if (!endpoint) return null;
  const price =
    typeof o.price_amount === 'number' && Number.isFinite(o.price_amount)
      ? o.price_amount
      : 0;
  const chain = typeof o.chain === 'string' ? o.chain : '';
  return {
    id: `x402watch-${stableId(endpoint)}`,
    name:
      (typeof o.name === 'string' && o.name) || safeHostname(endpoint) || endpoint,
    description: typeof o.description === 'string' ? o.description : '',
    endpoint,
    method: 'GET',
    price_usdc: price,
    price_atomic: Math.round(price * 1_000_000),
    chain: shortChain(chain),
    network: chain,
    category: typeof o.category === 'string' ? o.category : 'unknown',
    tags: [],
    verified: false,
    verified_at: '',
  };
}

/**
 * Try today's UTC date first, then yesterday. Snapshots are committed
 * once per UTC day, but the commit lands at an unknown time — early in
 * the UTC day, today's snapshot may not exist yet.
 */
function candidateDates(now: Date = new Date()): string[] {
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return [today, yesterday];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------- shared adapter helpers ----------

function appendQuery(baseUrl: string, params: Record<string, string>): string {
  try {
    const u = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v && v.length > 0) u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function humanMethod(raw: unknown): 'GET' | 'POST' {
  if (typeof raw === 'string' && raw.toUpperCase() === 'POST') return 'POST';
  return 'GET';
}

function shortChain(network: string): string {
  if (network === 'eip155:8453' || network === 'base') return 'base';
  if (network === 'eip155:84532' || network === 'base-sepolia') return 'base-sepolia';
  if (network.startsWith('solana')) return 'solana';
  if (network.startsWith('eip155:137') || network === 'polygon') return 'polygon';
  if (network.startsWith('eip155:42161') || network === 'arbitrum') return 'arbitrum';
  return network;
}

function stableId(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64);
}

/**
 * Client-side query filter for sources that don't support server-side
 * search (currently only x402watch, since it's a static daily snapshot).
 */
function matchesQuery(entry: RegistryEntry, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const haystack = (
    entry.name +
    ' ' +
    entry.description +
    ' ' +
    entry.tags.join(' ') +
    ' ' +
    entry.category
  ).toLowerCase();
  return terms.some((t) => haystack.includes(t));
}

/**
 * 402directory.com — jaypay's curated + community-submitted registry. Returns
 * `{ entries: [{ id, name, description, endpoint, method, price_usdc, chain,
 * protocol, category, tags, example, verified, source, badges? }] }`.
 * Server-side filtering not yet implemented, so we filter client-side using
 * matchesQuery (same as x402watch).
 */
export function make402DirectorySource(baseUrl: string): ExternalSource {
  return {
    id: '402directory',
    name: '402directory.com',
    async fetch(query, { signal, fetchFn }) {
      const r = await fetchFn(baseUrl, { signal });
      if (!r.ok) return [];
      const json = await r.json().catch(() => null);
      const list = (json as { entries?: unknown[] } | null)?.entries;
      if (!Array.isArray(list)) return [];
      const entries = list.flatMap((raw) => directoryRowToEntry(raw));
      return entries.filter((e) => matchesQuery(e, query));
    },
  };
}

function directoryRowToEntry(raw: unknown): RegistryEntry[] {
  const e = (raw ?? {}) as Record<string, unknown>;
  const endpoint = typeof e.endpoint === 'string' ? e.endpoint : null;
  if (!endpoint) return [];
  const price = typeof e.price_usdc === 'number' ? e.price_usdc : Number(e.price_usdc ?? 0);
  const chain = typeof e.chain === 'string' ? e.chain : 'base';
  return [
    {
      id: typeof e.id === 'string' ? e.id : `402dir-${stableId(endpoint)}`,
      name: typeof e.name === 'string' ? e.name : endpoint,
      description: typeof e.description === 'string' ? e.description : '',
      endpoint,
      method: e.method === 'POST' ? 'POST' : 'GET',
      price_usdc: Number.isFinite(price) ? price : 0,
      price_atomic: Number.isFinite(price) ? Math.round(price * 1_000_000) : 0,
      chain: shortChain(chain),
      network: chain === 'solana' ? 'solana' : 'eip155:8453',
      category: typeof e.category === 'string' ? e.category : 'general',
      tags: Array.isArray(e.tags) ? (e.tags as string[]) : [],
      example: typeof e.example === 'string' ? e.example : '',
      protocol: typeof e.protocol === 'string' ? (e.protocol as RegistryEntry['protocol']) : 'x402',
      verified: e.verified === true,
      verified_at: '',
    },
  ];
}
