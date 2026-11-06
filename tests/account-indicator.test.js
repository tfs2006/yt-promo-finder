import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Regression tests for the visible signed-in indicator.
//
// Bug (Nov 6, 2026): the site showed no signed-in state at all. The
// "Sign in with Google" button is static HTML and always renders,
// there was no user menu, avatar, or email anywhere, and the Credits
// number reads the same signed in or not. So nobody (including a
// browser test) could tell whether sign-in had worked.
// Fix: credits.js renders "Signed in as <email> - <N> credits" plus a
// Sign out action in the site header, and swaps the hero sign-in
// buttons to a disabled signed-in state. The indicator is HONEST: it
// renders only from an accountBalance the server just confirmed in a
// fetchBalances() response, never just because a token sits in
// localStorage. A stored token the server rejects is dropped and the
// user is shown signed out.

const script = readFileSync(new URL('../public/credits.js', import.meta.url), 'utf8');

function element() {
  const el = {
    id: '', innerHTML: '', textContent: '', disabled: false, value: '',
    style: {}, attributes: {}, dataset: {}, children: [], parentNode: null,
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this[name] = handler; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
      child.parentNode = null;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    cloneNode() { return element(); }
  };
  return el;
}

function makeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
    _store: store
  };
}

async function flush(times = 30) {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

// A fake JWT whose payload is {"exp": 9999999999} (far future).
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';
const ACCOUNT_RECORD = JSON.stringify({
  token: FAKE_JWT,
  expiresAt: Date.now() + 3600 * 1000
});

function setup({ seed = {}, balanceResponse = null }) {
  const storage = makeStorage(seed);
  const calls = { fetch: [], reload: 0 };
  const navTop = element();
  const heroButton = element();
  heroButton.textContent = 'Sign in with Google, get 3 free credits';
  const navButton = element();
  navButton.id = 'pfSignInButton';
  const body = element();
  const elements = new Map([['pfSignInButton', navButton]]);
  const documentHandlers = {};
  const context = vm.createContext({
    document: {
      readyState: 'complete',
      cookie: '',
      body,
      getElementById: (id) => elements.get(id) || null,
      createElement: () => element(),
      querySelector: (selector) => (selector === '.site-nav-top' ? navTop : null),
      querySelectorAll: (selector) => (
        selector === '[data-pf-signin="google"]' ? [heroButton] : []
      ),
      addEventListener: (name, handler) => { documentHandlers[name] = handler; }
    },
    window: {
      location: {
        hash: '', search: '', pathname: '/', origin: 'https://promofinder.4ourmedia.com',
        reload: () => { calls.reload++; }
      },
      localStorage: storage,
      history: { replaceState() {} },
      fetch: async (url) => {
        calls.fetch.push(String(url));
        return {
          ok: true,
          json: async () => balanceResponse
        };
      },
      atob: (s) => Buffer.from(s, 'base64').toString('utf8')
    },
    fetch: async (url) => {
      calls.fetch.push(String(url));
      return { ok: true, json: async () => balanceResponse };
    },
    setTimeout, clearTimeout, console: { error() {} },
    URL, URLSearchParams, Date
  });
  // credits.js reads the bare `fetch` global and `window.fetch`.
  context.window.fetch = context.fetch;
  vm.runInContext(script, context);
  return {
    calls, storage, navTop, heroButton, navButton, body, documentHandlers,
    context,
    indicator: () => navTop.children.find(c => c.id === 'pfAccountIndicator'),
    flush: async () => { await flush(); }
  };
}

const accountBalance = (overrides = {}) => ({
  provider: '4ourmedia',
  token: 'account',
  planId: '4ourmedia-account',
  planName: '4ourMedia Account',
  creditsRemaining: 4,
  creditsTotal: 7,
  status: 'active',
  email: 'davidjustin.exe@gmail.com',
  ...overrides
});

test('server-confirmed account renders the indicator and swaps sign-in buttons', async () => {
  const page = setup({
    seed: { pf_account_token_v1: ACCOUNT_RECORD },
    balanceResponse: {
      balances: [], accountBalance: accountBalance(), totalRemaining: 4, toolCosts: {}, plans: []
    }
  });
  await page.flush();
  const indicator = page.indicator();
  assert.ok(indicator, 'indicator must be injected into the site nav');
  assert.match(indicator.innerHTML, /Signed in as davidjustin\.exe@gmail\.com/);
  assert.match(indicator.innerHTML, /4 credits/);
  assert.match(indicator.innerHTML, /Sign out/);
  assert.equal(page.heroButton.disabled, true, 'hero sign-in button must be disabled when signed in');
  assert.equal(page.heroButton.textContent, 'Signed in as davidjustin.exe@gmail.com');
  assert.equal(page.navButton.style.display, 'none', 'nav sign-in button must be hidden when signed in');
});

test('a stored token the server rejects is dropped and the user is shown signed out', async () => {
  const page = setup({
    seed: { pf_account_token_v1: ACCOUNT_RECORD },
    balanceResponse: {
      balances: [], accountBalance: null, totalRemaining: 0, toolCosts: {}, plans: []
    }
  });
  await page.flush();
  assert.equal(page.storage.getItem('pf_account_token_v1'), null, 'rejected token must be cleared');
  assert.equal(page.indicator(), undefined, 'no indicator when the server rejects the token');
  assert.equal(page.heroButton.disabled, false, 'hero sign-in button must be enabled when signed out');
  assert.equal(page.heroButton.textContent, 'Sign in with Google, get 3 free credits');
  assert.equal(page.navButton.style.display, '', 'nav sign-in button must be shown when signed out');
});

test('no token at all renders signed out and never calls the balance endpoint', async () => {
  const page = setup({ seed: {}, balanceResponse: null });
  await page.flush();
  assert.equal(page.calls.fetch.length, 0, 'no balance fetch without a token');
  assert.equal(page.indicator(), undefined);
  assert.equal(page.heroButton.disabled, false);
  assert.equal(page.heroButton.textContent, 'Sign in with Google, get 3 free credits');
  assert.equal(page.navButton.style.display, '');
});

test('sign out clears the account and Supabase keys, keeps browser tokens, and reloads', async () => {
  const page = setup({
    seed: {
      pf_account_token_v1: ACCOUNT_RECORD,
      'sb-abcdef-auth-token': '{"access_token":"x"}',
      'sb-abcdef-auth-token-code-verifier': 'verifier',
      pf_credit_tokens_v1: JSON.stringify(['cs_test123']),
      pf_credit_balance_cache_v1: JSON.stringify({
        totalRemaining: 6,
        balances: [{ token: 'cs_test123', creditsRemaining: 2 }],
        accountBalance: accountBalance()
      })
    },
    balanceResponse: {
      balances: [{ token: 'cs_test123', planName: 'Credits Pack', creditsRemaining: 2, creditsTotal: 2 }],
      accountBalance: accountBalance(), totalRemaining: 6, toolCosts: {}, plans: []
    }
  });
  await page.flush();
  assert.ok(page.indicator(), 'indicator must be present before sign out');
  page.context.window.PFCredits.signOut();
  assert.equal(page.storage.getItem('pf_account_token_v1'), null, 'account token must be cleared');
  assert.equal(page.storage.getItem('sb-abcdef-auth-token'), null, 'Supabase session must be cleared');
  assert.equal(page.storage.getItem('sb-abcdef-auth-token-code-verifier'), null, 'code verifier must be cleared');
  assert.equal(
    page.storage.getItem('pf_credit_tokens_v1'),
    JSON.stringify(['cs_test123']),
    'browser credit tokens must be left alone'
  );
  const cache = JSON.parse(page.storage.getItem('pf_credit_balance_cache_v1'));
  assert.equal(cache.accountBalance, null, 'cached account balance must be cleared');
  assert.equal(cache.totalRemaining, 2, 'total must fall back to browser-token balances only');
  assert.equal(page.calls.reload, 1, 'page must reload after sign out');
});

test('the sign-out button in the indicator signs the user out', async () => {
  const page = setup({
    seed: { pf_account_token_v1: ACCOUNT_RECORD },
    balanceResponse: {
      balances: [], accountBalance: accountBalance(), totalRemaining: 4, toolCosts: {}, plans: []
    }
  });
  await page.flush();
  const indicator = page.indicator();
  assert.ok(indicator, 'indicator must be present');
  const signOutButton = element();
  signOutButton.closest = (selector) => (selector === '[data-pf-signout]' ? signOutButton : null);
  const clickHandler = page.documentHandlers.click;
  assert.ok(clickHandler, 'a document click handler must be bound for sign out');
  clickHandler({ target: signOutButton, preventDefault() {} });
  assert.equal(page.storage.getItem('pf_account_token_v1'), null, 'clicking Sign out must clear the account token');
  assert.equal(page.calls.reload, 1, 'clicking Sign out must reload the page');
});
