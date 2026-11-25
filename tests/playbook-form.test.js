import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/playbook-form.js', import.meta.url), 'utf8');
function setup(fetchImpl, valid = true) {
  const fields = {
    '[name="name"]': { value: '  Test Reader  ' },
    '[name="email"]': { value: '  reader@example.test  ' },
    '[name="phone"]': { value: '  (555) 123-4567  ' },
    '[name="consent"]': { checked: true, value: 'Agreed to playbook and updates' },
    '[name="source"]': { value: 'playbook' },
    '[name="_honey"]': { value: '' },
    'button[type="submit"]': { disabled: false },
    '[data-playbook-status]': { textContent: '' }
  };
  let submit;
  const download = { classList: { removed: [], remove(name) { this.removed.push(name); } } };
  const form = {
    attributes: {}, resetCount: 0, style: {},
    querySelector: selector => fields[selector],
    addEventListener: (_, handler) => { submit = handler; },
    reportValidity: () => valid,
    reset() { this.resetCount++; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const context = vm.createContext({
    document: { querySelectorAll: () => [form], getElementById: () => download },
    window: { fetch: fetchImpl }, fetch: fetchImpl, AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(script, context);
  return { form, fields, download, submit: () => submit({ preventDefault() {} }) };
}

test('playbook signup validates consent and fields before sending', async () => {
  let calls = 0;
  for (const scenario of ['invalid-form', 'no-consent', 'honeypot']) {
    const page = setup(async () => { calls++; }, scenario !== 'invalid-form');
    if (scenario === 'no-consent') page.fields['[name="consent"]'].checked = false;
    if (scenario === 'honeypot') page.fields['[name="_honey"]'].value = 'spam';
    await page.submit();
  }
  assert.equal(calls, 0);
});

test('success requires confirmed FormSubmit response and reveals the download', async () => {
  const page = setup(async (url, options) => {
    assert.equal(url, 'https://formsubmit.co/ajax/promofinder@4ourmedia.com');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body);
    assert.equal(payload.name, 'Test Reader');
    assert.equal(payload.email, 'reader@example.test');
    assert.equal(payload.phone, '(555) 123-4567');
    assert.equal(payload.source, 'playbook');
    assert.equal(payload.consent, 'Agreed to playbook and updates');
    assert.deepEqual(Object.keys(payload).sort(), ['_honey', '_subject', '_template', 'consent', 'email', 'name', 'phone', 'source']);
    return { ok: true, json: async () => ({ success: 'true' }) };
  });
  await page.submit();
  assert.equal(page.form.resetCount, 1);
  assert.equal(page.form.style.display, 'none');
  assert.deepEqual(page.download.classList.removed, ['hidden']);
  assert.match(page.fields['[data-playbook-status]'].textContent, /request was received/);
  assert.equal(page.fields['button[type="submit"]'].disabled, false);
  assert.equal(page.form.attributes['aria-busy'], 'false');
});

test('network, malformed, rejected and HTTP failures preserve inputs and allow retry', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    async () => ({ ok: true, json: async () => ({ success: false }) })
  ]) {
    const page = setup(fetchImpl);
    await page.submit();
    assert.match(page.fields['[data-playbook-status]'].textContent, /could not be confirmed/);
    assert.equal(page.fields['[name="email"]'].value, 'reader@example.test');
    assert.equal(page.fields['button[type="submit"]'].disabled, false);
    assert.equal(page.form.resetCount, 0);
    assert.deepEqual(page.download.classList.removed, []);
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
