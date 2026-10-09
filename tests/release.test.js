import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { sanitizeErrorMessage, fetchJson } from '../utils.js';
import { getToolAccessState, finalizeToolAccess } from '../lib/credits.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('vercel.json'));

test('every public inline script compiles', () => {
  for (const file of readdirSync(new URL('public/', root)).filter(name => name.endsWith('.html'))) {
    for (const [index, match] of [...read(`public/${file}`).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
      if (/application\/ld\+json/i.test(match[1])) JSON.parse(match[2]);
      else if (!/\btype=["']module/.test(match[1])) new vm.Script(match[2], { filename: `${file}:${index}` });
    }
  }
});

test('all explicit rewrite and redirect targets exist', () => {
  for (const route of [...config.rewrites, ...config.redirects]) {
    if (route.destination.includes('$') || route.destination.startsWith('http')) continue;
    const relative = route.destination.slice(1);
    assert.ok(existsSync(new URL(relative, root)) || existsSync(new URL(`public/${relative}`, root)), route.destination);
  }
  assert.equal(readdirSync(new URL('api/', root)).filter(name => name.endsWith('.js')).length, 12);
});

test('sitemap pages exist and owner demo remains non-indexable', () => {
  const locations = [...read('public/sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(match => new URL(match[1]));
  for (const url of locations) {
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(existsSync(new URL(`public/${path}`, root)) || existsSync(new URL(`public/${path}.html`, root)) || existsSync(new URL(`public/${path.replace(/\/$/, '')}/index.html`, root)), url.href);
  }
  assert.ok(!locations.some(url => url.pathname === '/owner-demo'));
  assert.match(read('public/owner-demo.html'), /name="robots" content="noindex,nofollow"/);
});

test('credential-bearing error messages are sanitized', () => {
  const message = sanitizeErrorMessage('https://example.com/?key=private-key&access_token=private-token&secret=private-secret');
  assert.doesNotMatch(message, /private-key|private-token|private-secret/);
  assert.match(message, /REDACTED/);
});

test('upstream HTTP errors expose neither URL nor response body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'private-response' });
  try {
    await assert.rejects(fetchJson('https://example.com/?key=private-key'), error => {
      assert.equal(error.code, 'UPSTREAM_ERROR');
      assert.doesNotMatch(error.message, /private-key|private-response|example.com/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('owner demo requires enablement, correct key, and permitted IP', async () => {
  const names = ['OWNER_DEMO_MODE', 'OWNER_DEMO_KEY', 'OWNER_DEMO_IP_ALLOWLIST', 'OWNER_DEMO_ALLOWLIST_IPS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const req = { headers: { 'x-owner-demo-key': 'synthetic-test-key', 'x-forwarded-for': '203.0.113.20', cookie: 'pf_free_search_used_v1=1' }, query: {} };
  const reqCookieFallback = { headers: { 'x-forwarded-for': '::ffff:203.0.113.20:443', cookie: 'pf_owner_demo_key_v1=synthetic-test-key; pf_free_search_used_v1=1' }, query: {} };
  try {
    process.env.OWNER_DEMO_MODE = 'true';
    process.env.OWNER_DEMO_KEY = 'synthetic-test-key';
    process.env.OWNER_DEMO_IP_ALLOWLIST = '203.0.113.20';
    delete process.env.OWNER_DEMO_ALLOWLIST_IPS;
    const state = await getToolAccessState(req, 'analyze');
    assert.equal(state.mode, 'owner_demo');
    const finalized = await finalizeToolAccess(req, {}, state);
    assert.equal(finalized.access.chargedCredits, 0);

    const cookieState = await getToolAccessState(reqCookieFallback, 'analyze');
    assert.equal(cookieState.mode, 'owner_demo');
    for (const [name, value] of [['OWNER_DEMO_MODE', 'false'], ['OWNER_DEMO_KEY', 'different'], ['OWNER_DEMO_IP_ALLOWLIST', '203.0.113.21']]) {
      const old = process.env[name];
      process.env[name] = value;
      assert.notEqual((await getToolAccessState(req, 'analyze')).mode, 'owner_demo');
      process.env[name] = old;
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});