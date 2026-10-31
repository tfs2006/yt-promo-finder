import test from 'node:test';
import assert from 'node:assert/strict';
import { kvSetNx } from '../utils.js';
import { claimCreditsSession } from '../lib/credits.js';

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
