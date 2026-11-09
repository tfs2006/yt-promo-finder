# PromoFinder: Drew Bryan credit purchase failure — diagnosis

Date: Nov 8, 2026 (investigated ~21:36-21:45 MST)
Repo: ~/workspace/promofinder-src (HEAD 693c3b2)
Vercel project: prj_1i06fdDFLViRQ4XurM848HMo9coO (promofinder.4ourmedia.com)
Stripe account: 4ourmedia, LLC (acct_1HAy8GHeryTj98X9, livemode)
Status: READ-ONLY investigation. No deploys, no Stripe writes, no refunds, no claim calls made.

## 1. What happened (buyer's words)

Drew Bryan (drewbryan12@gmail.com) tried to buy PromoFinder credits twice on Nov 8, 2026.
The checkout page told him both purchases "didn't go through". Both charges succeeded.
He emailed support@4ourmedia.com at 9:05 PM MST asking to cancel both $9 purchases.
David wants: (1) the 50 credits manually added to Drew's account, (2) the false-failure bug
fixed, (3) both done BEFORE any refund decision.

## 2. The two Stripe Checkout sessions (verified via Stripe API, read-only)

Both sessions: status `complete`, payment_status `paid`, $9.00 USD, mode `payment`,
success_url `https://promofinder.4ourmedia.com/credits?session_id={CHECKOUT_SESSION_ID}`.

### Session 1 (first purchase)
- Session id: `cs_live_b1hdOL6lQRBirgVbPgzio55Ed0Egg9Ue15lthvfTZ1mduBWuD7frtrI19I`
- Created: 2026-11-09 03:21:31 UTC (Nov 8, 8:21 PM MST)
- Payment intent: `pi_3UZj9SHeryTj98X91P7RNsw1`
- Charge: `ch_3UZj9SHeryTj98X91ix3BxwA` (succeeded)
- Stripe customer: `cus_VauzIpKc0o9ZAJ`, email drewbryan12@gmail.com
- Metadata: `purchase_type=credits`, `plan_id=starter`, `plan_name=Starter`,
  `credits_total=25`, `credits_remaining=25`,
  `scanpilot_license_key=SP-CN6PFG-AVNGCX-EB5HQ2`
- `pf_account_credited` marker: ABSENT

### Session 2 (second purchase, ~2 minutes later)
- Session id: `cs_live_b1A7ahSewPv6g773lmPqpAli4mY6Jdwqg4mscfNSEN0CU8tv7QaEvF34t4`
- Created: 2026-11-09 03:22:33 UTC (Nov 8, 8:22 PM MST)
- Payment intent: `pi_3UZjBIHeryTj98X91VdsH8Mg`
- Charge: `ch_3UZjBIHeryTj98X91oQkaKwR` (succeeded)
- Stripe customer: `cus_Vav1iBfFfzEXZz`, email drewbryan12@gmail.com
- Metadata: `purchase_type=credits`, `plan_id=starter`, `plan_name=Starter`,
  `credits_total=25`, `credits_remaining=25`,
  `scanpilot_license_key=SP-HX6UUT-68RAK2-ZSXXPN`
- `pf_account_credited` marker: ABSENT

Notes:
- The two purchases created TWO different Stripe customer records for the same email
  (`customer_creation: "always"` in lib/credits.js `createCreditsCheckoutSession`).
  The Stripe customer id is irrelevant to the PromoFinder account balance, which is
  keyed by Supabase user id, not by Stripe customer.
- The `scanpilot_license_key` in the session metadata is NOT set by
  `createCreditsCheckoutSession` (lib/credits.js) — no reference to that key exists
  anywhere in the repo (grep: zero hits). The deployed checkout code therefore
  differs from repo HEAD in at least this respect, OR the key is added by another
  system after session creation. Treat repo line numbers as the best available
  evidence, not as proven-live code, until the production bundle is diffed.
- For reference, an unrelated open (unpaid) Starter session and an open Program My
  County session also exist; neither is Drew's.

## 3. Were the 50 credits delivered to Drew's account?

NO — as far as any observable state shows. Evidence:

(a) Neither Stripe session carries the `pf_account_credited` metadata marker.
    That marker is written by `markSessionAccountCredited` (lib/credits.js) ONLY
    after `addCreditsToAccount` succeeds. Its absence means the account claim
    never completed a Supabase write for either session.
(b) There is NO server-side credit delivery path. The Stripe webhook handler
    (`handleCheckoutCompleted`, lib/smmHandlers.js:1195-1230) only handles SMM
    service orders: it looks up an order by session id, and when none exists it
    returns without doing anything. For a credits purchase there is no SMM order
    (`recoverOrderFromStripeSession` returns null when the session metadata has no
    `service_id`, lib/smmHandlers.js:498-520), so the webhook can never deliver
    credits. See section 6 for the full webhook analysis.
(c) The ONLY delivery path is the browser claim on the /credits page (section 4).
    A claim that throws delivers nothing and leaves no server-side trace other
    than the API error log.

What CANNOT be verified from this VM (honest gaps):
- Whether the claim request ran at all, and if so what exact error it threw.
  Decisive check: Vercel Runtime Logs for `GET /api/credits?action=claim`
  around 03:21-03:25 UTC Nov 9. `handleApiError` (utils.js:763-787) logs every
  claim throw with message and stack; the exact message names the failing branch.
- Whether the double-claim guard markers exist in Upstash KV
  (`pf_account_claim_v1:cs_live_...`). Decisive check: Upstash dashboard or REST
  read with the Vercel env credentials. No KV access exists from this VM.
- Drew's actual Supabase `users` balance right now. Decisive check: Supabase
  dashboard SQL Editor (see section 7, step 1). No Supabase access from this VM
  (Management API returns 403 for this runtime cell).
- Whether Drew's browser holds anonymous credit tokens (localStorage
  `pf_credit_tokens_v1`). Only Drew can check that, on the /credits page
  ("Saved balance detected"). If the claim took the anonymous path, his browser
  would show 50 credits in saved packs even though his account shows none.

## 4. How credit purchase fulfillment is supposed to work (the claim flow)

Checkout creation (POST /api/credits?action=checkout, api/predictor.js:206-227):
- Requires a signed-in Google account (`getCheckoutAccount` must resolve a
  `users` row, otherwise 402 AUTH_REQUIRED). Drew completed checkout twice, so
  his account token resolved to a `users` row at purchase time.
- Creates the Stripe session with `success_url = <base>/credits?session_id={CHECKOUT_SESSION_ID}`
  and metadata `purchase_type=credits`, `plan_id`, `credits_total`,
  `credits_remaining` (lib/credits.js `createCreditsCheckoutSession`).

Claim (GET /api/credits?action=claim&sessionId=..., api/predictor.js:194-196 ->
`claimCreditsSession`, lib/credits.js):
- `claimCreditsSession` (lib/credits.js) retrieves the session from Stripe with
  force-refresh, requires `payment_status === "paid"` and
  `metadata.purchase_type === "credits"` (`isPaidCreditSession`).
- The browser attaches the account token as the `x-account-token` header to all
  same-origin /api/* requests (`patchFetchForAccountToken`, public/credits.js:550-580).
- Account path (token valid): `readClaimMarker` checks the KV guard; if the
  marker says mode=token, it throws "already claimed to this browser".
  Otherwise `claimCreditsToAccount` acquires the atomic KV guard
  (`pf_account_claim_v1:<sessionId>`, SET NX, 400-day TTL), then
  `addCreditsToAccount` does `credits + N, total_purchased + N` on the shared
  Supabase `users` row with optimistic locking (3 attempts), then
  `markSessionAccountCredited` writes `pf_account_credited` to the Stripe
  session metadata as the durable audit marker.
- Anonymous path (no valid token): returns the session id as a browser token;
  credits live in localStorage, never in the account.
- Any throw inside `handleCredits` is caught in api/predictor.js:692-697 and
  returned by `handleApiError` (utils.js:763-787) as HTTP 500 with the
  sanitized error message. `requestJson` (public/credits.js:596-609) throws on
  any non-2xx, and credits.html:283-286 shows:
  "Purchase detected but not claimed" + the server error message.

The exact user-visible failure Drew saw is that box. It is the only in-app
message that says a completed, paid purchase was not claimed, and it reads as
"didn't go through" even though Stripe took the money.

## 5. Root cause of the false failure

### 5a. What the failure must be (narrowed by elimination)

A visible "Purchase detected but not claimed" error can only come from
`claimCreditsSession` throwing. The possible throw sites:

1. `getCreditSession` returns null (Stripe retrieve failed) ->
   "Credit session not found." (lib/credits.js)
2. `payment_status !== "paid"` at claim time ->
   "Checkout is not paid yet. Complete payment first." (lib/credits.js)
3. `addCreditsToAccount` returns null ->
   "Could not add credits to your 4ourMedia account. Please contact support."
   (lib/credits.js, `claimCreditsToAccount`)
4. A prior KV marker says mode=token / mode=account -> "already claimed"
   (impossible on a first claim; no marker can pre-exist for a fresh session).
5. Function-level failure (timeout after the 30s `maxDuration`,
   api/predictor.js:40, or an unhandled exception) -> HTTP 500 with the raw
   message.

Ruled out:
- Missing `users` row: the row is created by the `on_auth_user_created` trigger
  on Google sign-in (~/workspace/4ourmedia/supabase-schema.sql:159-176), and
  checkout creation already resolved Drew's row at 8:21 PM. Rows do not vanish.
- Expired account token: an expired/invalid token falls through to the
  ANONYMOUS path and returns success ("now saved in this browser"), not an
  error. So token expiry cannot produce the failure Drew saw.
- KV (Upstash) down: `acquireClaimGuard` throwing is caught and treated as
  degraded, and the claim proceeds via the Stripe-metadata fallback
  (lib/credits.js, `claimCreditsToAccount`). KV alone cannot block the claim.

### 5b. Prime suspect: the Supabase service-role key is missing in Vercel

`addCreditsToAccount` (lib/credits.js) uses ONLY the admin client:

```
const supabase = getSupabaseAdminClient();
if (!supabase) return null;
```

`getSupabaseAdminClient` returns null when `SUPABASE_URL` or
`SUPABASE_SERVICE_ROLE_KEY` is unset. There is NO user-client fallback here,
unlike `consumeAccountCredits` (the spend path), which falls back to
`createSupabaseUserClient(accountToken)` and therefore works even without the
service key. If the service-role key is not set in the PromoFinder Vercel
project (production), EVERY account-path claim fails with
"Could not add credits to your 4ourMedia account. Please contact support."
while the charge succeeds — exactly Drew's symptom, twice.

Supporting facts:
- `SUPABASE_SERVICE_ROLE_KEY` is referenced in exactly one place in the repo
  (lib/credits.js:75). No doc, README, DEPLOYMENT.md, or build log in the repo
  records it ever being set in Vercel for this project.
- The account-claim path was built Oct 31, 2026 (commit c3795e7, "Unify
  PromoFinder purchases with the 4ourMedia account system") and Drew is the
  FIRST buyer to exercise it since the Nov 2 sign-in wall made account claims
  the default path. No successful account claim has ever been observed.
  (Tommy Murphy's Oct 23 purchase predates the wall and used the anonymous
  token path.)
- David's own Nov 6 live test (Ad Libraries deducting 2 credits, balance 2 to 0)
  proves the SPEND path works. It does not prove the CLAIM path works, because
  the spend path has the user-client fallback and the claim path does not.
- The `users` table RLS policies ("Users can update own data",
  supabase-schema.sql:37-42) would let the fallback client update the buyer's
  own row, so adding the fallback is a valid fix, not just a workaround.

This is the leading hypothesis, not a proof. The proof is the Vercel Runtime
Log line for the claim (section 3, gap 1) or the env-var check (section 8).

### 5c. Secondary suspect: transient Stripe retrieve / payment-status timing

If the claim ran within seconds of the redirect, `stripe.checkout.sessions.retrieve`
could in principle return before `payment_status` flipped to `paid`, producing
"Checkout is not paid yet." Less likely than 5b (card Checkout redirects only
after confirmation), and it would not fail identically twice unless the timing
is systematic.

## 6. Webhook failure (Stripe email, Nov 8) — separate issue, NOT Drew's cause

### 6a. What the email says

Stripe emailed (received Nov 8): the webhook endpoint
`https://promofinder.4ourmedia.com/api/stripe-webhook` is failing. 13 attempts
since the first failure Nov 3, 2026 12:05 AM UTC, all HTTP 500. Stripe stops
sending Nov 12, 2026 12:05 AM UTC; this is the last notice before disabling.
The email warns: if Checkout fulfillment relies on `checkout.session.completed`,
review completed payments to ensure all recent purchases were fulfilled.

The failing event is Ron Tegeler's Program My County checkout
(`evt_1UXVDt`, Nov 2/3). The Nov 5 fix (commit cb2e67a) was deployed for it
(deployment dpl_DoF4c7q6ygg4BDLoQu4rcEA9rv1g, READY), but deliveries kept 500ing.

### 6b. Live probe results (Nov 8, ~21:44 MST, read-only)

- `GET https://promofinder.4ourmedia.com/api/stripe-webhook` -> HTTP 405
  ("Method not allowed"). The route EXISTS and is live; it is not a 404.
- `POST` with no `Stripe-Signature` header -> HTTP 400
  ("Missing Stripe-Signature header."). This proves `STRIPE_WEBHOOK_SECRET`
  IS set (non-empty) in the live production env: with no secret configured the
  handler falls through to unsigned `JSON.parse` and would return 200.
- `POST` with a bogus signature -> HTTP 500, body is Stripe's signature error:
  "No signatures found matching the expected signature for payload. Are you
  passing the raw request body you received from Stripe? ..."

So a signature failure produces exactly HTTP 500 from this endpoint, today.

### 6c. Where the handler lives, and why 500 rather than 404

- The Dashboard URL is CORRECT and needs no change. `vercel.json:87` rewrites
  `/api/stripe-webhook` -> `/api/predictor.js`, and `api/predictor.js:648`
  routes that pathname to `handleStripeWebhook` (lib/smmHandlers.js:1393).
  The old standalone `api/stripe-webhook.js` was deleted by commit cb2e67a,
  but the route was not deleted with it; it lives in predictor.js now.
- Do NOT restore `api/stripe-webhook.js`: that would create a 13th `api/*.js`
  file and break the Vercel Hobby 12-function cap.
- Why 500, not 404: the route resolves, the handler runs, and it throws
  before doing any business logic. `handleStripeWebhook`
  (lib/smmHandlers.js:1393-1430) verifies the signature with
  `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`; on
  mismatch Stripe's library throws, and `handleApiError` (utils.js:763-787)
  converts every such throw to HTTP 500.
- The business logic cannot be the 500 source for Ron's event (or Drew's):
  `handleCheckoutCompleted` (lib/smmHandlers.js:1195-1230) looks up an SMM
  order by session id; `recoverOrderFromStripeSession` (lib/smmHandlers.js:
  498-520) returns null when the session metadata has no `service_id`, which
  is true for both Ron's Program My County session (metadata
  `product=program-my-county`) and Drew's credit sessions (metadata
  `purchase_type=credits`). With no order, the handler returns early and the
  endpoint answers 200 `{received: true}`. A 500 therefore means the request
  died in signature verification (or, less likely, raw-body parsing) before
  reaching the business logic.

### 6d. Most likely cause of the persistent 500: signing-secret mismatch

The `STRIPE_WEBHOOK_SECRET` value in the PromoFinder Vercel project does not
match the signing secret of the Stripe Dashboard endpoint that posts to
`https://promofinder.4ourmedia.com/api/stripe-webhook`. The Nov 5 fix
addressed the route and the raw-body parsing (`bodyParser: false`,
api/predictor.js:40), but a wrong secret fails every delivery regardless of
route or body handling, which matches the observed pattern: 13 attempts, all
500, including attempts AFTER the Nov 5 deploy (a single post-fix success
would have stopped the retries for that event).

Possible ways the secret got wrong (unverifiable from this VM; check in order):
1. The env var was copied from the wrong endpoint's secret (note: the ScanPilot
   project has its own webhook endpoint `we_1UZ0UrHeryTj98X9ZS8KMkYP` and its
   own secret; the two must not be swapped).
2. The Dashboard endpoint was re-created at some point (new secret) without
   updating the Vercel env var.
3. A trailing `\r` / `\n` pasted into the Vercel value (the codebase already
   strips those from other env values in `asString`, lib/credits.js, but the
   webhook handler reads `STRIPE_WEBHOOK_SECRET` through the same `asString`
   in smmHandlers.js:1408, so this is the least likely of the three).

Alternative cause if the secrets DO match: raw-body mangling. The fix for
that is already deployed (bodyParser off), so a match would instead point at
the live deployment not being the fixed one; verify the production deployment
contains commit cb2e67a.

### 6e. Does the failing webhook explain Drew's missing credits? NO.

Credit fulfillment is claim-page-dependent, not webhook-dependent (section 3b
and 4). Even a perfectly working webhook would not have delivered Drew's
credits: `handleCheckoutCompleted` returns early for credits sessions, and no
other code credits accounts on `checkout.session.completed`. Conversely, fixing
the webhook will not fix Drew; the manual credit (section 7) and the
claim-flow fix (section 8) are still required. The webhook failure is a
separate, pre-existing issue whose only affected buyer is Ron, whose order was
already fulfilled manually and who was not harmed.

### 6f. Webhook fix and verification before Nov 12

1. In the Stripe Dashboard, open Developers -> Webhooks -> the endpoint for
   `https://promofinder.4ourmedia.com/api/stripe-webhook`. Open the delivery
   attempts for `evt_1UXVDt`: the recorded 500 response body should show the
   signature error, confirming section 6d. Reveal the endpoint's signing
   secret (begins `whsec_`).
2. In Vercel, open project prj_1i06fdDFLViRQ4XurM848HMo9coO -> Settings ->
   Environment Variables -> `STRIPE_WEBHOOK_SECRET` (production). Compare it
   with the Dashboard secret. If different, replace the Vercel value with the
   Dashboard value and REDEPLOY (env-var changes do not affect running
   serverless functions until a new deployment).
3. Verify before Nov 12: in the Dashboard, resend `evt_1UXVDt` (or use "Send
   test webhook" with a `checkout.session.completed` test event). A 200
   response proves the fix. Expected behavior on a successful resend of Ron's
   event: HTTP 200 with NO further action (no SMM order exists for that
   session, so the handler returns early). That is correct; Ron's order was
   already fulfilled manually.
4. If the secrets already match, do not change the secret. Instead verify the
   production deployment contains commit cb2e67a and re-test with a Dashboard
   test webhook; if it still 500s, the cause is raw-body handling on the live
   deployment, and the next step is a Vercel Runtime Log inspection of a live
   delivery.
5. Do NOT change the Dashboard endpoint URL, and do NOT restore
   `api/stripe-webhook.js` (13th-function cap).

## 7. Manual credit procedure: give Drew his 50 credits

The balance lives in the shared Supabase project's `public.users` table
(schema: ~/workspace/4ourmedia/supabase-schema.sql:17-29; columns `id` UUID,
`email`, `credits` INTEGER DEFAULT 3, `total_purchased` INTEGER DEFAULT 0,
`total_used` INTEGER DEFAULT 0, `updated_at`). There is no server endpoint
that grants credits; the ONLY grant path is the claim flow, which is the thing
that is broken. So this is done in the Supabase Dashboard SQL Editor, by
David. Do NOT call the claim endpoint on Drew's behalf.

### Step 1 — find Drew's row and current balance

Supabase Dashboard -> project pzmmllhpklcwmmeycxpm -> SQL Editor -> New query:

```sql
select id, email, credits, total_purchased, total_used
from public.users
where email = 'drewbryan12@gmail.com';
```

Expected: one row. `credits` is probably 3 (signup bonus) plus any daily
free credits he claimed on 4ourmedia.com. Note the `id` (UUID); it is needed
for steps 3-4. If zero rows come back, STOP: his `users` row is missing
(despite the signup trigger), and the fix is the INSERT in step 2b instead.

### Step 2a — add the 50 credits (25 per session, 2 sessions)

```sql
update public.users
set credits = credits + 50,
    total_purchased = total_purchased + 50,
    updated_at = now()
where email = 'drewbryan12@gmail.com'
returning id, email, credits, total_purchased, total_used;
```

The RETURNING clause is the verification: `credits` and `total_purchased`
must both be exactly 50 higher than step 1. (Use ADD, never SET to a fixed
number: his pre-existing balance from signup/daily claims must be preserved.)

### Step 2b — only if step 1 returned zero rows

```sql
insert into public.users (id, email, credits, total_purchased, total_used)
select id, email, 53, 50, 0
from auth.users
where email = 'drewbryan12@gmail.com'
on conflict (id) do update
  set credits = public.users.credits + 50,
      total_purchased = public.users.total_purchased + 50,
      updated_at = now()
returning id, email, credits, total_purchased, total_used;
```

(53 = 3 signup credits + 50 purchased.)

### Step 3 — verify from Drew's side

Ask Drew (or check on the next balance check) to open
https://promofinder.4ourmedia.com/credits while signed in: the header must
show "Signed in as drewbryan12@gmail.com" and the linked 4ourMedia account
balance must include the 50 credits. The Nov 12 PromoFinder credit-balance
check can confirm this if Drew's sign-in is available; otherwise his own
screenshot of the /credits page is the proof.

### Step 4 — prevent a later double-dispense (do this the same day)

After the manual credit, if Drew revisits
`/credits?session_id=cs_live_...` (e.g. from his Stripe receipt email) and
the claim flow is by then fixed, the claim would add ANOTHER 25 credits per
session, because `claimCreditsToAccount` (lib/credits.js) only checks the
Stripe metadata marker in its DEGRADED path, not in the healthy-guard path
(see section 8, fix 3). Two guard layers exist; set both:

(a) Upstash KV markers (the real guard). In the Upstash dashboard (or via
    REST with the `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` values
    copied from the Vercel dashboard, never pasted in chat), set for EACH
    session id:
    - Key: `pf_account_claim_v1:cs_live_b1hdOL6lQRBirgVbPgzio55Ed0Egg9Ue15lthvfTZ1mduBWuD7frtrI19I`
    - Key: `pf_account_claim_v1:cs_live_b1A7ahSewPv6g773lmPqpAli4mY6Jdwqg4mscfNSEN0CU8tv7QaEvF34t4`
    - Value (both): `{"mode":"account","userId":"<Drew's Supabase UUID from step 1>","claimedAt":"<ISO timestamp>"}`
    - TTL: 400 days (34,560,000 seconds), matching `ACCOUNT_CLAIM_TTL_SECONDS`.
    With these set, any later claim returns `alreadyClaimed: true` with a fresh
    balance and adds nothing.
(b) Stripe metadata markers (audit trail + degraded-path guard). On each of the
    two Checkout Sessions, set metadata `pf_account_credited` = Drew's Supabase
    user id and `pf_account_credited_at` = ISO timestamp. Do it in the Stripe
    Dashboard session view if its metadata editor allows it, otherwise via the
    Stripe API (`POST /v1/checkout/sessions/:id` with `metadata`). This alone
    does NOT block a re-claim while KV is healthy; it only covers the degraded
    path. Do (a) as the real protection and (b) for the record.
(c) Tell Drew the credits are in his account and he does not need to re-click
    any checkout link.

## 8. Code fix plan for the false-failure bug

### Step 0 — confirm the root cause before coding (30 minutes, no code)

1. Vercel -> project prj_1i06fdDFLViRQ4XurM848HMo9coO -> Settings ->
   Environment Variables: is `SUPABASE_SERVICE_ROLE_KEY` present for
   Production? (Name check only; never paste the value in chat.)
2. Vercel -> Deployments -> current production deployment -> Runtime Logs,
   filter for `/api/credits?action=claim` around 03:21-03:25 UTC Nov 9. The
   logged `api_error` message names the exact throw (section 5a).
3. Upstash dashboard: read `pf_account_claim_v1:cs_live_b1hdOL...` and
   `pf_account_claim_v1:cs_live_b1A7ah...`. Absent markers + absent Stripe
   metadata markers = the claim never completed a write.

### Fix 1 — make the account claim work without the service key (the robust fix)

File: `lib/credits.js`, `addCreditsToAccount` and `getAccountRow`.
- Give both functions the same fallback `consumeAccountCredits` already uses:
  `getSupabaseAdminClient() || createSupabaseUserClient(accountToken)`.
  That requires threading the account token through `claimCreditsToAccount`
  (it already receives the `account` object; pass the token alongside it).
- Why it is safe: the `users` RLS policies ("Users can view own data",
  "Users can update own data", supabase-schema.sql:37-42) permit the signed-in
  buyer to read and update their OWN row, which is exactly what the claim
  does. The optimistic-locking pattern (`.eq("credits", currentCredits)`,
  3 attempts) is unchanged.
- Separately, ALSO set `SUPABASE_SERVICE_ROLE_KEY` in Vercel production
  (copy it from Supabase Dashboard -> Settings -> API -> service_role key)
  and redeploy, so the admin path works as originally designed. Do both: the
  env fix restores the intended path, the fallback removes the single point of
  failure.

### Fix 2 — never show a paid purchase as failed; make the claim retryable

Files: `public/credits.html` (claim error state, lines 283-286),
`public/credits.js` (`claimSession`, lines 669-670).
- On claim failure, keep the "Purchase detected" heading but change the copy
  to state the payment SUCCEEDED and the credits are safe: e.g. "Payment
  received, credits not added yet" + the reason + a Retry button that re-calls
  `claimSession(sessionId)`. Retrying is safe by design: the KV guard makes a
  second claim idempotent (`alreadyClaimed: true`, fresh balance, no double
  credit).
- Do not surface raw server messages that read as payment failure
  ("Checkout is not paid yet", "Credit session not found") without the
  payment-succeeded context.

### Fix 3 — close the double-dispense hole for manually credited sessions

File: `lib/credits.js`, `claimCreditsToAccount`.
- Check `session.metadata.pf_account_credited` BEFORE acquiring the KV guard,
  not only in the `guardDegraded` branch. If the marker is set, return
  `alreadyClaimed: true` with the fresh balance and add nothing.
- This makes the Stripe metadata marker authoritative, so the manual procedure
  in section 7 step 4b alone is sufficient protection even if the KV markers
  in step 4a are ever missed.

### Fix 4 (structural, after the immediate fix) — server-side fulfillment

- Add webhook fulfillment for `purchase_type=credits`: in
  `handleCheckoutCompleted` (lib/smmHandlers.js:1195), before the SMM-only
  early return, handle sessions whose metadata says `purchase_type=credits`
  by crediting the matching Supabase account (resolve the buyer by the
  `users.email` matching `session.customer_details.email`, or better: store
  the Supabase user id as `client_reference_id` at checkout creation in
  `createCreditsCheckoutSession` and read it back in the webhook).
- This removes the browser claim as a single point of failure: credits land
  even if the buyer closes the tab after paying. The browser claim stays as
  the immediate path and the idempotency guard stays as the double-spend
  protection; the webhook and the claim must share the same guard.
- Note the dependency: this only works once the webhook itself is fixed
  (section 6f). Do Fix 4 after the webhook secret is corrected and a test
  delivery returns 200.

### Constraints (must NOT change)

- No price changes; no other tool credit costs change. Pack menu untouched.
- `api/*.js` count stays at 12 (Vercel Hobby cap). All changes are inside
  `lib/credits.js`, `lib/smmHandlers.js`, `api/predictor.js`,
  `public/credits.js`, `public/credits.html`. No new `api/*.js` file.
- `api/predictor.js` keeps `bodyParser: false` and `maxDuration: 30`
  (api/predictor.js:40); the webhook depends on raw-body access.
- Tests: add tests for Fix 1 (claim succeeds with user client when admin
  client is absent), Fix 3 (metadata marker blocks a re-claim), and Fix 2
  (retry path). Run the full suite (`npm test`, currently 105 pass, 0 fail)
  before any deploy. Verify the live deploy by the deployment record (READY),
  not by a probe alone.

## 9. What this diagnosis does NOT establish

- The exact claim error Drew saw (needs Vercel Runtime Logs, section 3 gap 1).
- Whether `SUPABASE_SERVICE_ROLE_KEY` is set in Vercel production (needs the
  Vercel dashboard; this VM has no Vercel access in this session).
- Whether the Upstash KV claim markers exist (needs Upstash access).
- Drew's current Supabase balance (needs the Supabase dashboard, section 7
  step 1).
- Whether the deployed production code matches repo HEAD (the
  `scanpilot_license_key` in both sessions' metadata is set by code that does
  not exist in this repo; diff the live bundle or the production deployment
  before treating any repo line number as proven-live).
