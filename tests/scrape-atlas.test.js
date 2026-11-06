import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { saGet, getScrapeAtlasKey, isScrapeAtlasConfigured, ScrapeAtlasError } from '../lib/scrapeAtlas.js';
import { sanitizeErrorMessage, resolveChannelId } from '../utils.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.SCRAPE_ATLAS_API_KEY;

function mockFetch(responder) {
  globalThis.fetch = async (url, options) => responder(url, options);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.SCRAPE_ATLAS_API_KEY;
  else process.env.SCRAPE_ATLAS_API_KEY = originalKey;
});

test('getScrapeAtlasKey strips a pasted literal trailing backslash-r', () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'test-key\\r';
  assert.equal(getScrapeAtlasKey(), 'test-key');
  assert.equal(isScrapeAtlasConfigured(), true);
  process.env.SCRAPE_ATLAS_API_KEY = '  test-key\\n  ';
  assert.equal(getScrapeAtlasKey(), 'test-key');
  delete process.env.SCRAPE_ATLAS_API_KEY;
  assert.equal(getScrapeAtlasKey(), '');
  assert.equal(isScrapeAtlasConfigured(), false);
});

test('saGet sends the key as x-api-key and returns the parsed body', async () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'secret-key-123';
  let seenUrl = '';
  let seenHeaders = {};
  mockFetch(async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ success: true, channelId: 'UCtest123', fetchedAt: '2026-11-06T00:00:00.000Z' }) };
  });
  const body = await saGet('/v1/youtube/channel', { tool: 'test', params: { handle: '@test' } });
  assert.equal(body.channelId, 'UCtest123');
  assert.match(seenUrl, /api\.scrapeatlas\.com\/v1\/youtube\/channel/);
  assert.match(seenUrl, /handle=%40test/);
  assert.equal(seenHeaders['x-api-key'], 'secret-key-123');
});

test('saGet maps HTTP errors to typed codes without leaking the key', async () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'secret-key-123';
  const cases = [
    [401, 'SA_UNAUTHORIZED'],
    [404, 'SA_NOT_FOUND'],
    [429, 'SA_RATE_LIMITED'],
    [503, 'SA_BUSY']
  ];
  for (const [status, code] of cases) {
    mockFetch(async () => ({ ok: false, status, json: async () => ({ success: false, failure: { code: 'x', message: 'boom' } }) }));
    await assert.rejects(saGet('/v1/test', { tool: 'test' }), error => {
      assert.ok(error instanceof ScrapeAtlasError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret-key-123/);
      return true;
    });
  }
});

test('saGet throws SA_NOT_CONFIGURED with no key', async () => {
  delete process.env.SCRAPE_ATLAS_API_KEY;
  await assert.rejects(saGet('/v1/test', { tool: 'test' }), error => error.code === 'SA_NOT_CONFIGURED');
});

test('sanitizeErrorMessage redacts the Scrape Atlas key', () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'sa-live-abcdef';
  assert.doesNotMatch(sanitizeErrorMessage('header x-api-key: sa-live-abcdef failed'), /sa-live-abcdef/);
  assert.match(sanitizeErrorMessage('header x-api-key: sa-live-abcdef failed'), /REDACTED/);
});

test('resolveChannelId resolves via Scrape Atlas first (no YouTube search)', async () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'secret-key-123';
  const urls = [];
  mockFetch(async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ success: true, channelId: 'UCsaResolved123' }) };
  });
  // Unique handle per run: resolveChannelId persists resolutions to the
  // file-backed KV cache, so a reused handle would return cached and skip fetch.
  const id = await resolveChannelId({ type: 'handle', value: `@SomeChannel${Date.now()}` });
  assert.equal(id, 'UCsaResolved123');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /scrapeatlas\.com/);
  assert.doesNotMatch(urls[0], /googleapis/);
});

test('resolveChannelId falls back to YouTube search when Scrape Atlas fails', async () => {
  process.env.SCRAPE_ATLAS_API_KEY = 'secret-key-123';
  const urls = [];
  mockFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes('scrapeatlas.com')) {
      return { ok: false, status: 404, json: async () => ({ success: false, failure: { code: 'not_found' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [{ snippet: { channelId: 'UCytFallback456' } }] }) };
  });
  // Unique handle per run: the file-backed KV cache would otherwise
  // return the earlier run's resolution and skip fetch entirely.
  const id = await resolveChannelId({ type: 'handle', value: `@FallbackChannel${Date.now()}` });
  assert.equal(id, 'UCytFallback456');
  assert.ok(urls.some(u => u.includes('scrapeatlas.com')));
  assert.ok(urls.some(u => u.includes('googleapis.com')));
});
