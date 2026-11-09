import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kvSetNx } from '../utils.js';
import { claimCreditsSession, claimCreditsToAccount, getSupabaseWriteClient } from '../lib/credits.js';

// Offline-safe tests for the unified purchase claim flow.
// No Stripe, Supabase, or Redis calls are made: invalid ids fail before any
// network, and kvSetNx falls back to file storage when Redis is absent.

test('kvSetNx is set-if-absent', async () => {
  const key = `test_claim_guard_${Date.now()}`;
  assert.equal(await kvSetNx(key, 'a'), true);
  assert.equal(await kvSetNx(key, 'b'), false);
  assert.equal(await kvSetNx(`${key}_other`, 'c'), true);
});

test('claim rejects malformed Stripe session ids without network', async () => {
  await assert.rejects(
    () => claimCreditsSession('not-a-session'),
    /Invalid Stripe session id/
  );
  await assert.rejects(
    () => claimCreditsSession(''),
    /Invalid Stripe session id/
  );
});

test('claim of unknown session id reports not found, not paid', async () => {
  // getCreditSession catches the Stripe client error (no key in test env)
  // and returns null, so this exercises the lookup-failure branch only.
  await assert.rejects(
    () => claimCreditsSession('cs_test_doesnotexist000'),
    /Credit session not found/
  );
});

test('claim accepts an optional request argument', async () => {
  // req=null must behave exactly like the old single-arg call.
  await assert.rejects(
    () => claimCreditsSession('cs_test_doesnotexist001', null),
    /Credit session not found/
  );
  await assert.rejects(
    () => claimCreditsSession('cs_test_doesnotexist002', { headers: {}, query: {} }),
    /Credit session not found/
  );
});

// Fix 1 (Drew Bryan, Nov 8 2026): the account claim must work even when
// SUPABASE_SERVICE_ROLE_KEY is missing from the deployment, by falling back
// to the signed-in buyer's own client, the same fallback consumeAccountCredits
// uses for spending. Without the fallback, every account-path claim failed
// with "Could not add credits" while the charge succeeded.
test('account claim falls back to the buyer client when the service key is absent', async () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key-for-test';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    // No token at all: no client can be built, admin or user.
    assert.equal(getSupabaseWriteClient(''), null);
    // A signed-in buyer's JWT builds the user client (createClient does
    // not hit the network at construction, so this stays offline-safe).
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const client = getSupabaseWriteClient(fakeJwt);
    assert.notEqual(client, null);
    assert.equal(typeof client.from, 'function');
  } finally {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
    if (saved.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.service;
  }
});

// Fix 3: a session already marked credited in Stripe metadata must never
// dispense again, even when the KV guard marker was never set (the case for
// a manually credited session whose buyer re-opens the checkout link).
test('a session already marked credited in Stripe metadata never dispenses twice', async () => {
  const result = await claimCreditsToAccount(
    {
      id: 'cs_test_alreadycredited000',
      metadata: { plan_id: 'starter', credits_total: 25, pf_account_credited: 'user-123' }
    },
    { userId: 'user-123' }
  );
  assert.equal(result.account, true);
  assert.equal(result.alreadyClaimed, true);
});

test('without the metadata marker the claim still tries to dispense (and fails offline)', async () => {
  // Control for the test above: the same session without pf_account_credited
  // proceeds past the guard and fails only because no Supabase client exists
  // in the test env. This proves the marker is what short-circuits.
  // The session id is unique per run: the claim guard writes its marker to
  // the file-backed KV fallback before dispensing, so a fixed id would make
  // this test pass only once per checkout and then resolve as alreadyClaimed
  // on every later run (stale marker from Nov 9 04:49 UTC did exactly that).
  const sessionId = `cs_test_notcredited_${Date.now().toString(36)}`;
  await assert.rejects(
    () => claimCreditsToAccount(
      {
        id: sessionId,
        metadata: { plan_id: 'starter', credits_total: 25 }
      },
      { userId: 'user-123' }
    ),
    /Could not add credits to your 4ourMedia account/
  );
});

// Fix 2: a failed claim must never read as a failed payment, and the buyer
// must get a Retry button that re-runs the (idempotent) claim.
test('credits page shows payment-succeeded copy and a retry button on claim failure', () => {
  const html = readFileSync(new URL('../public/credits.html', import.meta.url), 'utf8');
  assert.match(html, /Payment received, credits not added yet/);
  assert.match(html, /Your payment went through successfully/);
  assert.match(html, /id="claimRetryBtn"/);
  assert.match(html, /Retry adding credits/);
  assert.match(html, /addEventListener\('click', attemptClaim\)/);
  assert.doesNotMatch(html, /Purchase detected but not claimed/);
});
