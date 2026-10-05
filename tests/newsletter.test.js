import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/newsletter.js', import.meta.url), 'utf8');
function setup(fetchImpl, valid = true) {
  const fields = {
    '[name="email"]': { value: '  reader@example.test  ' },
    '[name="consent"]': { checked: true, value: 'Agreed to updates' },
    '[name="source"]': { value: 'unlisted' },
    '[name="_honey"]': { value: '' },
    'button[type="submit"]': { disabled: false },
    '[data-newsletter-status]': { textContent: '' }
  };
  let submit;
  const form = {
    attributes: {}, resetCount: 0,
    querySelector: selector => fields[selector],
    addEventListener: (_, handler) => { submit = handler; },
    reportValidity: () => valid,
    reset() { this.resetCount++; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const context = vm.createContext({ document: { querySelectorAll: () => [form] }, window: { fetch: fetchImpl }, fetch: fetchImpl, AbortController, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  return { form, fields, submit: () => submit({ preventDefault() {} }) };
}

test('signup validates consent and email before sending', async () => {
  let calls = 0;
  for (const scenario of ['invalid-email', 'no-consent', 'honeypot']) {
    const page = setup(async () => { calls++; }, scenario !== 'invalid-email');
    if (scenario === 'no-consent') page.fields['[name="consent"]'].checked = false;
    if (scenario === 'honeypot') page.fields['[name="_honey"]'].value = 'spam';
    await page.submit();
  }
  assert.equal(calls, 0);
});

test('success requires confirmed FormSubmit response and sends no search data', async () => {
  const page = setup(async (url, options) => {
    assert.equal(url, 'https://formsubmit.co/ajax/promofinder@4ourmedia.com');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body);
    assert.equal(payload.email, 'reader@example.test');
    assert.equal(payload.source, 'unlisted');
    assert.equal(payload.consent, 'Agreed to updates');
    assert.deepEqual(Object.keys(payload).sort(), ['_honey', '_subject', '_template', 'consent', 'email', 'source']);
    return { ok: true, json: async () => ({ success: 'true' }) };
  });
  await page.submit();
  assert.equal(page.form.resetCount, 1);
  assert.match(page.fields['[data-newsletter-status]'].textContent, /request was received/);
  assert.equal(page.fields['button[type="submit"]'].disabled, false);
  assert.equal(page.form.attributes['aria-busy'], 'false');
});

test('network, malformed, rejected and HTTP failures preserve email and allow retry', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    async () => ({ ok: true, json: async () => ({ success: false }) })
  ]) {
    const page = setup(fetchImpl);
    await page.submit();
    assert.match(page.fields['[data-newsletter-status]'].textContent, /could not be confirmed/);
    assert.equal(page.fields['[name="email"]'].value, 'reader@example.test');
    assert.equal(page.fields['button[type="submit"]'].disabled, false);
    assert.equal(page.form.resetCount, 0);
  }
});

test('duplicate submits are locked until FormSubmit completes', async () => {
  let release;
  let calls = 0;
  const page = setup(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = page.submit();
  await page.submit();
  assert.equal(calls, 1);
  assert.equal(page.fields['button[type="submit"]'].disabled, true);
  release({ ok: true, json: async () => ({ success: true }) });
  await first;
  assert.equal(page.fields['button[type="submit"]'].disabled, false);
});
