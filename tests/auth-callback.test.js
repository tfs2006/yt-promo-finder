import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Regression tests for the /auth/callback sign-in flow.
//
// Bug (Nov 6, 2026): run() called client.auth.getSession() before
// checking for a fresh `code` param. When localStorage held a
// stale/expired Supabase session, getSession() returned it,
// finishWithSession() stored its already-expired access token, and the
// homepage deleted the expired token record on read, so the user came
// back signed out. The stale session was never cleared, so every later
// attempt short-circuited the same way and never self-healed.
// Fix: a fresh code always wins over the stored session, and a stored
// session is only trusted while it still has usable life left; an
// expired one is signed out instead of trusted.

const html = readFileSync(new URL('../public/auth/callback.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('function run()'));
assert.ok(script, 'callback page must contain the run() script');

function element() {
  return {
    innerHTML: '', textContent: '', disabled: false, value: '', style: {},
    attributes: {},
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this[name] = handler; },
    appendChild() {},
    querySelector() { return element(); },
    cloneNode() { return element(); }
  };
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function setup({ search = '', hash = '', storedSession = null }) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const calls = {
    getSession: 0, signOut: 0, setSession: 0,
    exchangeCode: [], setAccountToken: [], replaced: []
  };
  let timerFn = null;
  const client = {
    auth: {
      getSession: async () => {
        calls.getSession++;
        return { data: { session: storedSession } };
      },
      signOut: async () => {
        calls.signOut++;
        return { error: null };
      },
      setSession: async () => {
        calls.setSession++;
        return { data: { session: null }, error: null };
      },
      exchangeCodeForSession: async (code) => {
        calls.exchangeCode.push(code);
        return {
          data: {
            session: {
              access_token: 'fresh-jwt.a.b',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: 'user-1', email: 'davidjustin.exe@gmail.com' }
            }
          },
          error: null
        };
      }
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'user-1' } })
        })
      })
    })
  };
  const context = vm.createContext({
    document: { getElementById: getElement, createElement: element },
    window: {
      location: {
        search, hash, origin: 'https://promofinder.4ourmedia.com',
        replace: (url) => { calls.replaced.push(url); }
      },
      sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
      supabase: { createClient: () => client },
      PFCredits: {
        setAccountToken: (token) => { calls.setAccountToken.push(token); },
        signInWithGoogle() {}
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ auth: { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon-key' } })
    }),
    setTimeout: (fn) => { timerFn = fn; return 0; },
    clearTimeout: () => {},
    console: { error() {} },
    URL, URLSearchParams, Date
  });
  vm.runInContext(script, context);
  return {
    calls,
    getElement,
    runTimer: async () => { timerFn(); await flush(); }
  };
}

const past = () => Math.floor(Date.now() / 1000) - 3600;
const future = () => Math.floor(Date.now() / 1000) + 3600;

test('a fresh sign-in code beats a stored session', async () => {
  const page = setup({
    search: '?code=fresh-code-123',
    storedSession: {
      access_token: 'stale-jwt.a.b',
      expires_at: past(),
      user: { id: 'user-1', email: 'old@example.com' }
    }
  });
  await page.runTimer();
  assert.equal(page.calls.getSession, 0, 'stored session must not be consulted when a code is present');
  assert.deepEqual(page.calls.exchangeCode, ['fresh-code-123']);
  assert.deepEqual(page.calls.setAccountToken, ['fresh-jwt.a.b'], 'the fresh exchanged token must be stored, not the stale one');
  assert.equal(page.calls.signOut, 0);
  assert.deepEqual(page.calls.replaced, ['/']);
});

test('an expired stored session is cleared, not trusted', async () => {
  const page = setup({
    search: '',
    storedSession: {
      access_token: 'stale-jwt.a.b',
      expires_at: past(),
      user: { id: 'user-1', email: 'old@example.com' }
    }
  });
  await page.runTimer();
  assert.equal(page.calls.signOut, 1, 'expired stored session must be signed out');
  assert.deepEqual(page.calls.setAccountToken, [], 'expired token must never be stored');
  assert.deepEqual(page.calls.exchangeCode, []);
  assert.equal(page.getElement('status').textContent, 'Sign-in did not complete.');
});

test('a valid stored session is still trusted when there is no code', async () => {
  const page = setup({
    search: '',
    storedSession: {
      access_token: 'valid-jwt.a.b',
      expires_at: future(),
      user: { id: 'user-1', email: 'davidjustin.exe@gmail.com' }
    }
  });
  await page.runTimer();
  assert.equal(page.calls.getSession, 1);
  assert.equal(page.calls.signOut, 0);
  assert.deepEqual(page.calls.setAccountToken, ['valid-jwt.a.b']);
  assert.deepEqual(page.calls.exchangeCode, []);
  assert.deepEqual(page.calls.replaced, ['/']);
});

test('a stored session about to expire is treated as expired', async () => {
  const page = setup({
    search: '',
    storedSession: {
      access_token: 'stale-jwt.a.b',
      expires_at: Math.floor(Date.now() / 1000) + 30,
      user: { id: 'user-1', email: 'old@example.com' }
    }
  });
  await page.runTimer();
  assert.equal(page.calls.signOut, 1, 'session expiring within 60s must be cleared');
  assert.deepEqual(page.calls.setAccountToken, []);
});
