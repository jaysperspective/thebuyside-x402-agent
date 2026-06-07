import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/lookup.js';
import type { RegistryEntry } from '../src/registry/types.js';

const ENTRIES: RegistryEntry[] = [
  {
    id: 'newsep-stories',
    name: 'Executive Producer — local US news',
    description: 'Search local news by market.',
    endpoint: 'https://news-ep.com/api/v1/stories',
    method: 'GET',
    price_usdc: 0.005,
    price_atomic: 5000,
    chain: 'base',
    network: 'eip155:8453',
    category: 'news',
    tags: ['news', 'local', 'houston'],
    verified: true,
    verified_at: '2026-05-10',
  },
  {
    id: 'fake-weather',
    name: 'Fake Weather API',
    description: 'Forecast for any city.',
    endpoint: 'https://example-weather.test/api/now',
    method: 'GET',
    price_usdc: 0.002,
    price_atomic: 2000,
    chain: 'base',
    network: 'eip155:8453',
    category: 'weather',
    tags: ['weather', 'forecast', 'climate'],
    verified: false,
    verified_at: '2026-01-01',
  },
];

describe('Registry', () => {
  describe('search', () => {
    const r = new Registry(ENTRIES);

    it('matches a single tag term', () => {
      const out = r.search('houston');
      expect(out.map((e) => e.id)).toEqual(['newsep-stories']);
    });

    it('matches across name + description + tags', () => {
      const out = r.search('weather forecast');
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('fake-weather');
    });

    it('scores multi-term matches higher', () => {
      // "news local" matches news-ep (both terms in tags) — only 1 entry has both
      const out = r.search('news local');
      expect(out[0].id).toBe('newsep-stories');
    });

    it('returns empty for no matches', () => {
      expect(r.search('nonexistent-term-xyz')).toEqual([]);
    });

    it('returns all entries when query is empty (capped by limit)', () => {
      expect(r.search('')).toHaveLength(2);
      expect(r.search('', { limit: 1 })).toHaveLength(1);
    });

    it('is case-insensitive', () => {
      expect(r.search('HOUSTON').map((e) => e.id)).toEqual(['newsep-stories']);
    });
  });

  describe('hosts', () => {
    it('returns the unique sorted hostnames', () => {
      const r = new Registry(ENTRIES);
      expect(r.hosts()).toEqual(['example-weather.test', 'news-ep.com']);
    });

    it('handles {placeholder} path templates without crashing', () => {
      const r = new Registry([
        {
          ...ENTRIES[0],
          id: 'detail',
          endpoint: 'https://news-ep.com/api/v1/stories/{id}',
        },
      ]);
      expect(r.hosts()).toEqual(['news-ep.com']);
    });

    it('returns [] for an empty registry', () => {
      expect(new Registry([]).hosts()).toEqual([]);
    });
  });

  describe('byId', () => {
    it('finds an entry by id', () => {
      const r = new Registry(ENTRIES);
      expect(r.byId('newsep-stories')?.name).toBe('Executive Producer — local US news');
      expect(r.byId('does-not-exist')).toBeUndefined();
    });
  });

  describe('load', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'tbs-registry-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('loads entries from a JSON file', async () => {
      const path = join(dir, 'seed.json');
      await writeFile(
        path,
        JSON.stringify({ version: 1, entries: ENTRIES }),
      );
      const r = await Registry.load(path);
      expect(r.entries).toHaveLength(2);
      expect(r.byId('newsep-stories')).toBeDefined();
    });

    it('falls back to empty registry on missing file', async () => {
      const r = await Registry.load(join(dir, 'does-not-exist.json'));
      expect(r.entries).toHaveLength(0);
    });

    it('falls back to empty registry on malformed JSON', async () => {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{ not valid json');
      const r = await Registry.load(path);
      expect(r.entries).toHaveLength(0);
    });
  });

  describe('default seed.json', () => {
    it('loads the bundled seed.json (may be empty — discovery federates live)', async () => {
      const r = await Registry.load();
      // Seed is intentionally empty post-v0.5 cleanup; live discovery comes from
      // 402directory.com + other federation sources. Just assert the file loads.
      expect(Array.isArray(r.entries)).toBe(true);
    });
  });
});
