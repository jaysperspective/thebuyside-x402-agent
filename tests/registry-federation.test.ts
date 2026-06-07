/**
 * Unit tests for the federation orchestrator and the three external-source
 * adapters. Uses an in-memory fetch mock — no real network. Adapter response
 * fixtures match real upstream shapes verified against live endpoints on
 * 2026-05-10.
 */

import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Federation,
  makeAgenticMarketSource,
  makeCdpBazaarSource,
  makeX402WatchSource,
  type ExternalSource,
} from '../src/registry/federation.js';
import type { RegistryEntry } from '../src/registry/types.js';

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'fake',
    name: 'Fake',
    description: 'fake desc',
    endpoint: 'https://fake.test/api',
    method: 'GET',
    price_usdc: 0.005,
    price_atomic: 5000,
    chain: 'base',
    network: 'eip155:8453',
    category: 'misc',
    tags: ['fake'],
    verified: false,
    verified_at: '',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gzipResponse(body: unknown, status = 200): Response {
  const buf = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
  // Construct from a Uint8Array so node-fetch's Response treats it as binary.
  return new Response(new Uint8Array(buf), {
    status,
    headers: { 'content-type': 'application/gzip' },
  });
}

function makeMockFetch(byUrl: Map<RegExp, () => Promise<Response>>): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of byUrl) {
      if (pattern.test(url)) return handler();
    }
    throw new Error(`mockFetch: no handler for ${url}`);
  };
}

describe('Federation orchestrator', () => {
  it('returns [] when disabled', async () => {
    const fed = new Federation({
      enabled: false,
      timeoutMs: 1000,
      sources: [stubSource('cdp-bazaar', () => [makeEntry()])],
    });
    expect(await fed.search('news')).toEqual([]);
  });

  it('returns [] when no sources are configured', async () => {
    const fed = new Federation({ enabled: true, timeoutMs: 1000, sources: [] });
    expect(await fed.search('news')).toEqual([]);
  });

  it('fans out to all sources in parallel and merges results', async () => {
    const fed = new Federation({
      enabled: true,
      timeoutMs: 1000,
      sources: [
        stubSource('cdp-bazaar', () => [makeEntry({ id: 'a', endpoint: 'https://a.test/' })]),
        stubSource('agentic-market', () => [
          makeEntry({ id: 'b', endpoint: 'https://b.test/' }),
        ]),
        stubSource('x402watch', () => [makeEntry({ id: 'c', endpoint: 'https://c.test/' })]),
      ],
    });
    const out = await fed.search('news');
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('tags each entry with its source id', async () => {
    const fed = new Federation({
      enabled: true,
      timeoutMs: 1000,
      sources: [
        stubSource('cdp-bazaar', () => [makeEntry({ id: 'a', endpoint: 'https://a.test/' })]),
        stubSource('agentic-market', () => [
          makeEntry({ id: 'b', endpoint: 'https://b.test/' }),
        ]),
      ],
    });
    const out = await fed.search('news');
    const sourceById = Object.fromEntries(out.map((e) => [e.id, e.source]));
    expect(sourceById.a).toBe('cdp-bazaar');
    expect(sourceById.b).toBe('agentic-market');
  });

  it('preserves an explicit `source` set by the adapter (does not overwrite)', async () => {
    const fed = new Federation({
      enabled: true,
      timeoutMs: 1000,
      sources: [
        stubSource('cdp-bazaar', () => [
          makeEntry({ id: 'a', endpoint: 'https://a.test/', source: 'verified' }),
        ]),
      ],
    });
    const out = await fed.search('news');
    expect(out[0].source).toBe('verified');
  });

  it('swallows errors from one source without affecting others', async () => {
    const fed = new Federation({
      enabled: true,
      timeoutMs: 1000,
      sources: [
        stubSource('cdp-bazaar', () => {
          throw new Error('bazaar exploded');
        }),
        stubSource('agentic-market', () => [
          makeEntry({ id: 'survives', endpoint: 'https://b.test/' }),
        ]),
      ],
    });
    const out = await fed.search('news');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('survives');
  });

  it('aborts a slow source on timeout and continues with the rest', async () => {
    const fed = new Federation({
      enabled: true,
      timeoutMs: 30,
      sources: [
        {
          id: 'cdp-bazaar',
          name: 'slow',
          async fetch(_q, { signal }) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 500);
              signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new Error('aborted'));
              });
            });
            return [makeEntry({ id: 'never', endpoint: 'https://x.test/' })];
          },
        },
        stubSource('agentic-market', () => [
          makeEntry({ id: 'fast', endpoint: 'https://b.test/' }),
        ]),
      ],
    });
    const out = await fed.search('news');
    expect(out.map((e) => e.id)).toEqual(['fast']);
  });
});

describe('Federation.fromEnv', () => {
  const ENV_KEYS = [
    'X402_FEDERATION',
    'X402_FEDERATION_TIMEOUT_MS',
    'X402_BAZAAR_URL',
    'X402_AGENTIC_URL',
    'X402_X402WATCH_URL',
    'X402_DIRECTORY_URL',
    'X402_DISABLE_BAZAAR',
    'X402_DISABLE_AGENTIC',
    'X402_DISABLE_X402WATCH',
    'X402_DISABLE_402DIRECTORY',
  ];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to enabled with all four sources', () => {
    const fed = Federation.fromEnv();
    expect(fed.config.enabled).toBe(true);
    expect(fed.config.sources.map((s) => s.id).sort()).toEqual([
      '402directory',
      'agentic-market',
      'cdp-bazaar',
      'x402watch',
    ]);
  });

  it('honors X402_FEDERATION=off', () => {
    process.env.X402_FEDERATION = 'off';
    expect(Federation.fromEnv().config.enabled).toBe(false);
  });

  it('honors per-source disable env vars', () => {
    process.env.X402_DISABLE_BAZAAR = '1';
    process.env.X402_DISABLE_AGENTIC = '1';
    process.env.X402_DISABLE_402DIRECTORY = '1';
    const ids = Federation.fromEnv().config.sources.map((s) => s.id);
    expect(ids).toEqual(['x402watch']);
  });

  it('falls back to default timeout on bad input', () => {
    process.env.X402_FEDERATION_TIMEOUT_MS = 'not-a-number';
    expect(Federation.fromEnv().config.timeoutMs).toBe(1500);
  });

  it('parses a custom timeout', () => {
    process.env.X402_FEDERATION_TIMEOUT_MS = '3000';
    expect(Federation.fromEnv().config.timeoutMs).toBe(3000);
  });
});

describe('CDP Bazaar source adapter', () => {
  // Verified live shape (2026-05-10): GET /platform/v2/x402/discovery/search
  // → { partialResults, resources: [{ resource, description, accepts: [...] }] }
  it('parses a /discovery/search response into RegistryEntry[]', async () => {
    let observedUrl: string | null = null;
    const fetchFn: typeof fetch = async (input) => {
      observedUrl = typeof input === 'string' ? input : input.toString();
      return jsonResponse({
        partialResults: false,
        resources: [
          {
            resource: 'https://news-ep.com/api/v1/stories',
            description: 'Local US news search',
            lastUpdated: '2026-05-10T00:00:00Z',
            accepts: [
              {
                scheme: 'exact',
                network: 'base',
                asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                maxAmountRequired: '5000',
                payTo: '0xc8CaE186fb4f382D3DD9C82cbA976C255531540C',
                maxTimeoutSeconds: 300,
                extra: { name: 'USD Coin', version: '2' },
              },
            ],
          },
        ],
      });
    };

    const source = makeCdpBazaarSource(
      'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search',
    );
    const out = await source.fetch('news', {
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(observedUrl).toMatch(/query=news/);
    expect(out).toHaveLength(1);
    expect(out[0].endpoint).toBe('https://news-ep.com/api/v1/stories');
    expect(out[0].description).toBe('Local US news search');
    expect(out[0].name).toBe('news-ep.com');
    expect(out[0].price_atomic).toBe(5000);
    expect(out[0].price_usdc).toBeCloseTo(0.005);
    expect(out[0].chain).toBe('base');
  });

  it('prefers the Base accept option when multiple chains are offered', async () => {
    const fetchFn = makeMockFetch(
      new Map([
        [
          /.*/,
          async () =>
            jsonResponse({
              resources: [
                {
                  resource: 'https://multi.test/api',
                  description: 'multi-chain',
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                      amount: '999',
                      payTo: 'AbbuSAH5Ur4a47KSVEzy4dP4wvLY8DSvdQDbJuJjiWfW',
                    },
                    {
                      scheme: 'exact',
                      network: 'eip155:8453',
                      amount: '5000',
                      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      payTo: '0xc8CaE186fb4f382D3DD9C82cbA976C255531540C',
                      extra: { name: 'USD Coin', version: '2' },
                    },
                  ],
                },
              ],
            }),
        ],
      ]),
    );
    const source = makeCdpBazaarSource('https://api.cdp.coinbase.com/...');
    const out = await source.fetch('multi', {
      signal: new AbortController().signal,
      fetchFn,
    });
    expect(out[0].price_atomic).toBe(5000);
    expect(out[0].network).toBe('eip155:8453');
    expect(out[0].chain).toBe('base');
  });

  it('handles both `amount` (v2) and `maxAmountRequired` (v1) field names', async () => {
    const fetchFn = makeMockFetch(
      new Map([
        [
          /.*/,
          async () =>
            jsonResponse({
              resources: [
                {
                  resource: 'https://v2.test/api',
                  accepts: [{ network: 'base', amount: '1234' }],
                },
                {
                  resource: 'https://v1.test/api',
                  accepts: [{ network: 'base', maxAmountRequired: '5678' }],
                },
              ],
            }),
        ],
      ]),
    );
    const source = makeCdpBazaarSource('https://api.cdp.coinbase.com/...');
    const out = await source.fetch('test', {
      signal: new AbortController().signal,
      fetchFn,
    });
    expect(out.map((e) => e.price_atomic).sort((a, b) => a - b)).toEqual([1234, 5678]);
  });

  it('returns [] on non-200 response', async () => {
    const fetchFn = makeMockFetch(new Map([[/.*/, async () => jsonResponse({}, 404)]]));
    const source = makeCdpBazaarSource('https://api.cdp.coinbase.com/...');
    expect(
      await source.fetch('news', { signal: new AbortController().signal, fetchFn }),
    ).toEqual([]);
  });

  it('returns [] when JSON shape is unexpected', async () => {
    const fetchFn = makeMockFetch(
      new Map([[/.*/, async () => jsonResponse({ totally: 'wrong shape' })]]),
    );
    const source = makeCdpBazaarSource('https://api.cdp.coinbase.com/...');
    expect(
      await source.fetch('news', { signal: new AbortController().signal, fetchFn }),
    ).toEqual([]);
  });
});

describe('agentic.market source adapter', () => {
  // Verified live shape (2026-05-10): GET /v1/services/search?q=...
  // → { services: [{ name, description, category, networks, endpoints: [
  //         { url, method, description, pricing: {amount, currency, network, scheme} }
  //       ] }] }
  it('flattens services[].endpoints[] into one entry per endpoint', async () => {
    let observedUrl: string | null = null;
    const fetchFn: typeof fetch = async (input) => {
      observedUrl = typeof input === 'string' ? input : input.toString();
      return jsonResponse({
        services: [
          {
            id: 'exa-ai',
            name: 'Exa',
            description: 'AI-powered web search',
            category: 'Search',
            networks: ['Base'],
            endpoints: [
              {
                url: 'https://api.exa.ai/contents',
                method: 'POST',
                description: 'Content retrieval',
                pricing: {
                  amount: '0.001',
                  currency: 'USDC',
                  network: 'Base',
                  scheme: 'exact',
                },
              },
              {
                url: 'https://api.exa.ai/search',
                method: 'POST',
                description: 'Web search',
                pricing: {
                  amount: '0.007',
                  currency: 'USDC',
                  network: 'Base',
                  scheme: 'upto',
                },
              },
            ],
          },
        ],
      });
    };

    const source = makeAgenticMarketSource('https://api.agentic.market/v1/services/search');
    const out = await source.fetch('search', {
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(observedUrl).toMatch(/q=search/);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.endpoint)).toEqual([
      'https://api.exa.ai/contents',
      'https://api.exa.ai/search',
    ]);
    expect(out[0].method).toBe('POST');
    expect(out[0].price_usdc).toBeCloseTo(0.001);
    expect(out[0].price_atomic).toBe(1000);
    expect(out[1].price_atomic).toBe(7000);
    expect(out[0].category).toBe('Search');
    expect(out[0].chain).toBe('base');
    expect(out[0].network).toBe('eip155:8453');
    expect(out[0].name).toContain('Exa');
  });

  it('skips endpoints without a url', async () => {
    const fetchFn = makeMockFetch(
      new Map([
        [
          /.*/,
          async () =>
            jsonResponse({
              services: [
                {
                  name: 'X',
                  endpoints: [
                    { method: 'GET' /* no url */ },
                    { url: 'https://valid.test/', method: 'GET', pricing: { amount: '0.005' } },
                  ],
                },
              ],
            }),
        ],
      ]),
    );
    const source = makeAgenticMarketSource('https://api.agentic.market/v1/services/search');
    const out = await source.fetch('q', {
      signal: new AbortController().signal,
      fetchFn,
    });
    expect(out).toHaveLength(1);
    expect(out[0].endpoint).toBe('https://valid.test/');
  });
});

describe('x402watch source adapter', () => {
  // Verified live shape (2026-05-10): gzipped JSON snapshot at
  // raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz
  // Body: { snapshot_date, services: [{ resource_url, name, description,
  //          category, chain, price_amount, ... }] }
  // price_amount is a float USDC value (NOT atomic).
  it('downloads + gunzips today\'s snapshot and filters by query', async () => {
    let observedUrl: string | null = null;
    const fetchFn: typeof fetch = async (input) => {
      observedUrl = typeof input === 'string' ? input : input.toString();
      return gzipResponse({
        snapshot_date: '2026-05-10',
        service_count: 2,
        services: [
          {
            id: 1,
            chain: 'base',
            resource_url: 'https://news.test/api',
            name: 'NewsAPI',
            description: 'fresh news',
            category: 'news',
            price_amount: 0.005,
          },
          {
            id: 2,
            chain: 'base',
            resource_url: 'https://weather.test/api',
            name: 'WeatherAPI',
            description: 'forecasts',
            category: 'weather',
            price_amount: 0.002,
          },
        ],
      });
    };

    const source = makeX402WatchSource(
      'https://raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz',
    );
    const out = await source.fetch('weather', {
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(observedUrl).toMatch(/services-\d{4}-\d{2}-\d{2}\.json\.gz$/);
    expect(out).toHaveLength(1);
    expect(out[0].endpoint).toBe('https://weather.test/api');
    expect(out[0].name).toBe('WeatherAPI');
    expect(out[0].price_atomic).toBe(2000);
    expect(out[0].price_usdc).toBeCloseTo(0.002);
  });

  it("falls back to yesterday's snapshot when today's 404s", async () => {
    const seenUrls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      seenUrls.push(url);
      if (seenUrls.length === 1) {
        return new Response('not found', { status: 404 });
      }
      return gzipResponse({
        services: [
          {
            chain: 'base',
            resource_url: 'https://yesterday.test/api',
            name: 'Y',
            price_amount: 0.001,
          },
        ],
      });
    };
    const source = makeX402WatchSource(
      'https://raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz',
    );
    const out = await source.fetch('', {
      signal: new AbortController().signal,
      fetchFn,
    });
    expect(seenUrls).toHaveLength(2);
    expect(out).toHaveLength(1);
    expect(out[0].endpoint).toBe('https://yesterday.test/api');
  });

  it('caches the snapshot in-process so a second call does not re-fetch', async () => {
    let fetches = 0;
    const fetchFn: typeof fetch = async () => {
      fetches += 1;
      return gzipResponse({
        services: [
          {
            chain: 'base',
            resource_url: 'https://cached.test/api',
            name: 'C',
            description: 'cached service',
            price_amount: 0.005,
          },
        ],
      });
    };
    const source = makeX402WatchSource(
      'https://raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz',
    );
    await source.fetch('cached', { signal: new AbortController().signal, fetchFn });
    await source.fetch('cached', { signal: new AbortController().signal, fetchFn });
    expect(fetches).toBe(1);
  });

  it('returns [] when both today and yesterday 404', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response('not found', { status: 404 });
    const source = makeX402WatchSource(
      'https://raw.githubusercontent.com/printmoneylab/x402watch-data/main/data/services-{date}.json.gz',
    );
    expect(
      await source.fetch('', { signal: new AbortController().signal, fetchFn }),
    ).toEqual([]);
  });
});

// ---------- helpers ----------

function stubSource(
  id: 'cdp-bazaar' | 'agentic-market' | 'x402watch',
  produce: () => RegistryEntry[] | Promise<RegistryEntry[]>,
): ExternalSource {
  return {
    id,
    name: id,
    async fetch() {
      return produce();
    },
  };
}
