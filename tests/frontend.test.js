import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('const form ='));
const quota = { used: 0, remaining: 10000, usableRemaining: 9500, percentUsed: 0 };
const response = (body, status = 200) => ({ ok: status < 400, json: async () => body });

function element() {
  const selectors = new Map();
  return {
    innerHTML: '', textContent: '', disabled: false, value: '', style: {}, attributes: {}, children: [],
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this[name] = handler; },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, element());
      return selectors.get(selector);
    },
    cloneNode() { return element(); }
  };
}

function setup(analyzeFetch, quotaFetch = async () => response(quota)) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  getElement('promoRow').content = { firstElementChild: element() };
  const context = vm.createContext({
    document: { getElementById: getElement, createElement: element },
    window: { location: { origin: 'http://localhost' } },
    fetch: (url, options) => url === '/api/quota' ? quotaFetch(options) : analyzeFetch(url),
    console: { error() {} }, URL, Blob, AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(script, context);
  getElement('url').value = '@example';
  return {
    context, getElement,
    submit: () => getElement('form').submit({ preventDefault() {} }),
    evaluate: source => vm.runInContext(source, context)
  };
}

test('network failures restore the button and accessible loading state', async () => {
  const page = setup(async () => { throw new TypeError('Offline'); });
  await page.submit();
  assert.equal(page.getElement('submitBtn').disabled, false);
  assert.equal(page.getElement('btnText').textContent, 'Analyze');
  assert.equal(page.getElement('results').attributes['aria-busy'], 'false');
  assert.match(page.getElement('status').innerHTML, /Check your connection/);
});

test('invalid JSON and unexpected response shapes remain recoverable', async () => {
  for (const result of [
    { ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } },
    response({ unexpected: true })
  ]) {
    const page = setup(async () => result);
    await page.submit();
    assert.equal(page.getElement('submitBtn').disabled, false);
    assert.match(page.getElement('status').innerHTML, /Search could not finish/);
  }
});

test('rapid submissions are locked before the quota request resolves', async () => {
  let release;
  const pendingQuota = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const page = setup(async () => {
    calls++;
    return response({ promotions: [], videoCount: 0, sinceISO: '2026-01-01' });
  }, () => pendingQuota);
  const first = page.submit();
  assert.equal(page.getElement('submitBtn').disabled, true);
  await page.submit();
  release(response(quota));
  await first;
  assert.equal(calls, 1);
});

test('quota exhaustion blocks analysis and a refreshed quota re-enables it', async () => {
  let calls = 0;
  const page = setup(async () => { calls++; }, async () => response({ ...quota, isExhausted: true }));
  await page.submit();
  assert.equal(calls, 0);
  assert.equal(page.getElement('submitBtn').disabled, true);
  page.evaluate(`updateQuotaBanner(${JSON.stringify(quota)})`);
  assert.equal(page.getElement('submitBtn').disabled, false);
});

test('HTTP errors safely display text and leave searches usable', async () => {
  for (const [status, body] of [
    [500, { error: '<img src=x onerror="alert(1)">' }],
    [402, { code: 'PAYMENT_REQUIRED', error: '<b>Buy credits</b>' }],
    [429, { code: 'RATE_LIMITED' }]
  ]) {
    const page = setup(async () => response(body, status));
    await page.submit();
    assert.equal(page.getElement('submitBtn').disabled, false);
    assert.doesNotMatch(page.getElement('status').innerHTML, /<img|<b>/);
  }
});

test('video titles render as text and unsafe promotion protocols have no link', async () => {
  const title = '<img src=x onerror="alert(1)"> & "review"';
  const page = setup(async () => response({
    videoCount: 1, sinceISO: '2026-01-01', promotions: [{
      productName: 'Example', domain: 'example.com', url: 'javascript:alert(1)', occurrences: 1,
      videos: [{ title, videoId: 'abc"def', publishedAt: '2026-01-01' }]
    }]
  }));
  await page.submit();
  const row = page.getElement('results').children[1];
  assert.equal(row.querySelector('a').href, undefined);
  const video = row.querySelector('ul').children[0];
  assert.equal(video.querySelector('a').textContent, title);
  assert.equal(video.querySelector('a').href, 'https://www.youtube.com/watch?v=abc%22def');
  assert.doesNotMatch(video.innerHTML, /<img/);
});

test('CSV quotes every field and neutralizes spreadsheet formulas', async () => {
  const page = setup(async () => response({ promotions: [] }));
  assert.equal(page.evaluate('serializeCsvCell(\'a,"b"\\n雪\')'), '"a,""b""\n雪"');
  assert.equal(page.evaluate('serializeCsvCell("https://example.com/?q=a,b")'), '"https://example.com/?q=a,b"');
  for (const text of ['=SUM(1,2)', '+cmd', '-cmd', '@SUM(1)', '  =1+1', '\t=1+1']) {
    assert.equal(page.evaluate(`serializeCsvCell(${JSON.stringify(text)})`), `"'${text}"`);
  }
  assert.equal(page.evaluate('serializeCsvCell(null)'), '""');
  assert.equal(page.evaluate('serializeCsvCell(3)'), '"3"');
  let exported;
  page.context.capture = blob => { exported = blob; };
  page.evaluate(`lastResults = { channelId: 'example', promotions: [{
    productName: 'A,"B"', domain: 'example.com', url: 'https://example.com/?q=a,b',
    occurrences: 2, videos: [{ title: '=1+1', videoId: 'abc' }]
  }] }; downloadBlob = capture; exportToCSV();`);
  assert.equal(await exported.text(), '"Product Name","Domain","URL","Mentions","Sample Video","Video URL"\r\n"A,""B""","example.com","https://example.com/?q=a,b","2","\'=1+1","https://www.youtube.com/watch?v=abc"');
});

test('shared payment markup escapes API text while retaining credit links', () => {
  const context = vm.createContext({
    window: { location: { pathname: '/' } },
    document: { readyState: 'loading', addEventListener() {} }, URL, URLSearchParams
  });
  vm.runInContext(readFileSync(new URL('../public/credits.js', import.meta.url), 'utf8'), context);
  const markup = context.window.PFCredits.getPaymentRequiredMarkup({
    error: '<img src=x> & "credits"', toolCost: '2',
    balances: [{ creditsRemaining: '2' }, { creditsRemaining: '3' }],
    accountBalance: { planName: '<script>bad</script>', creditsRemaining: 4 }
  });
  assert.doesNotMatch(markup, /<img|<script>/);
  assert.match(markup, /&lt;img src=x&gt; &amp; &quot;credits&quot;/);
  assert.match(markup, /5 credits/);
  assert.match(markup, /costs 2 credits/);
  assert.match(markup, /href="\/credits"/);
});

test('malformed promotion links cannot interrupt valid results', async () => {
  const page = setup(async () => response({
    videoCount: 2, sinceISO: '2026-01-01', promotions: [
      null, { domain: 'missing-url' },
      { domain: 'invalid', url: 'https://[broken', occurrences: 1, videos: [] },
      { domain: 'example.com', url: 'https://example.com', occurrences: 1, videos: [] }
    ]
  }));
  await page.submit();
  assert.equal(page.getElement('results').children.length, 3);
  assert.equal(page.getElement('submitBtn').disabled, false);
  assert.equal(page.getElement('results').children[2].querySelector('a').href, 'https://example.com/');
});