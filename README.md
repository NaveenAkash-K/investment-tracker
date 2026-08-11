# Investment Tracker

A private, manual portfolio tracker built for a personal INR-based portfolio. It tracks holdings, planned SIPs, target allocation, notes, archives, monthly snapshots, and contribution-adjusted monthly performance.

USD categories separate:

- actual INR contribution;
- market gain or loss in the foreign asset;
- USD/INR appreciation or depreciation;
- combined gain or loss in INR.

The first enhanced monthly review is a baseline. Accurate market and currency attribution starts with the following month; historical snapshots are retained as value-only history.

The Targets page includes a new-money allocation autopilot. It uses the entered budget to reduce target drift without selling and does not change SIP plans automatically. Monthly Review and Dashboard show contribution-adjusted monthly returns plus linked 3, 6, and 12-month returns once enough consecutive non-baseline reviews exist.

## Local setup

1. Install packages with `npm install`.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local`.
3. For a new Supabase project, apply every SQL file in `supabase/migrations` in filename order, starting with [the initial schema](supabase/migrations/202607190001_initial_schema.sql). For an existing installation, apply only migrations newer than the last one already run. The current final migration is [rereview residual hardening](supabase/migrations/202608110003_rereview_residual_hardening.sql).
4. Run `npm run dev` and open `http://localhost:3000`.

Migrations are transactional. The Kite migrations add the fail-closed Swing execution data model, isolate encrypted sessions from browser access, support read-only static-IP reconciliation, simulated Paper Auto, Personal Free GTT Assisted, Assisted Live approvals, and capped Live Auto with broker transport restricted to the VPS service role. The final hardening migrations pin broker identity, prioritize reduce-only exits, account for broker charges and partial realizations, retain technical watchlists separately from actionable candidates, and claim news delivery before SMTP.

## Market Intelligence integration

The companion analyser in `D:\Projects\Personal\market-analyser` can read the tracker's current holdings, targets and SIP plans, then publish daily alerts, weekly reports and monthly bounded SIP suggestions back to this app.

1. Apply the Market Intelligence migration listed above.
2. Open **Market Intelligence → Configure signal mappings** and map every active SIP plan to one or more supported market keys. Category mappings improve portfolio-fit scoring; a missing or obsolete category mapping is reported explicitly and makes that market non-actionable.
3. On the analyser machine, set `INVESTMENT_TRACKER_SUPABASE_URL`, `INVESTMENT_TRACKER_SUPABASE_SERVICE_ROLE_KEY` and `INVESTMENT_TRACKER_USER_ID` as server-side environment variables.
4. Set `supabase.enabled` to `true` in the analyser config and run a preview before scheduling it.

The service-role key must never be placed in `.env.local`, browser code or any public client bundle. Market recommendations remain advisory: Monthly Review records the actual amount invested and remains the source of truth.
The integration uses the shared versioned contract in `contracts/analyzer-tracker-contract.v2.json`. Current payloads are validated in Python and Supabase; legacy records remain visible with a warning, while unknown versions are rejected. “Data coverage” describes input availability and freshness, not the probability of a correct recommendation. Market valuation columns are explicitly valuation proxies and include method, source and as-of date.

## Swing Lab workflow

Swing Lab is a separate risk budget and journal for end-of-day Indian-equity swing trades. It does not change long-term holdings, SIP allocations, or Monthly Review.

1. Apply all migrations through `202608110003_rereview_residual_hardening.sql`. The 09:25 IST weekday monitor checks only existing candidates and positions; the 17:30 IST workflow calculates completed-session regime, technical setups and actionable candidates. The 08:00 IST portfolio workflow is a separate operation and cannot publish Swing results.
2. Set trading capital, risk per trade, position limits, sector limit, and the minimum setup score in **Swing Lab → Risk controls**. Keep paper mode on while validating the process.
3. A candidate is only a plan. Buy only after its entry trigger trades and never above the displayed maximum-entry price. Carried-forward candidates remain visible, but entry confirmation is disabled when the latest scan is failed, stale, unpublished, or unsupported.
4. In Advisory mode, confirm an actual or manual paper fill in Swing Lab. When Paper Auto is armed, a fresh Kite trigger crossing can create a simulated paper trade automatically.
5. The daily analyser updates current price, raises trailing stops without lowering them, and flags exits. Confirm the actual exit fill in the app to close the journal entry.

The scanner is long-only and uses the Nifty 500 universe, liquidity and trend gates, relative strength, a recent-breakout pullback, volatility-sized entries/stops, market breadth, sector caps, and portfolio-level risk limits. RED blocks new candidates. AMBER requires the higher score threshold, halves configured risk, and publishes at most one new candidate. Existing candidates and positions continue to be monitored in every regime. No qualified candidate is a normal result; the application never forces capital into a trade. Exchange holidays and provider-session mismatches cannot create new candidates. A detected split or bonus pauses the affected trade until broker-adjusted entry, quantity, and stop values are reconciled in the UI.

### Kite authentication foundation

The execution rollout contains four modes: Advisory, Paper Auto, Assisted Live and capped Live Auto. Tracker/Vercel routes never submit broker orders. A separate static-IP VPS worker owns the narrow Kite order/GTT adapter and is disabled unless both database rollout locks and explicit VPS environment gates are enabled.

Full portfolio restore is intentionally fail-closed: it disconnects Kite and removes live approvals, leases, active protection, worker observations and active risk locks. Immutable terminal order/fill/realization history is retained for audit, but it cannot arm execution. Reconnect and reconcile the real broker account after any restore.

Set these only in server-side local/Vercel environments after applying `202608020001_swing_kite_auth_foundation.sql`:

- `INVESTMENT_TRACKER_APP_URL` — the production origin, without a path;
- `KITE_API_KEY` — the app API key;
- `KITE_API_SECRET` — the app secret, never exposed to the browser;
- `KITE_TOKEN_ENCRYPTION_KEY` — a base64-encoded random 32-byte key.

The registered Kite redirect URL must be `${INVESTMENT_TRACKER_APP_URL}/api/kite/callback`. Authentication attempts are user-bound, single-use and expire after ten minutes. Stored access-token ciphertext is not selectable by authenticated browser clients. The displayed session expires at 06:00 IST on the next calendar day. Disconnecting removes the encrypted session and returns automation controls to advisory/disarmed mode.

After applying `202608020002_kite_readonly_worker.sql`, Swing Lab also displays
the latest static-IP worker heartbeat, read-only broker account snapshot, and
live Swing position reconciliation. The VPS functions are executable only by
the Supabase service role and accept `observe` mode only. A heartbeat older than
ten minutes is shown as unavailable; it never inherits a previous healthy state.

After applying `202608020003_swing_paper_auto.sql` and deploying the companion
analyser's `kite_paper_worker.py` service, Swing Lab can be armed for the current
NSE session. Paper Auto uses read-only full quotes, requires a newly observed
upward trigger crossing after 09:20 IST, refuses stale quotes and chased entries,
and simulates adverse slippage plus delivery charges. Pausing new entries does
not stop protection of existing Paper Auto positions. All Paper Auto events are
idempotent and included in full backup/restore; restore always returns the mode
to Advisory. No broker order transport exists in this batch.

## News & Events workflow

News & Events is an evidence-led advisory feed. The companion analyser reads official and news RSS/Atom sources, normalizes and deduplicates articles, groups related reports into events, applies deterministic impact rules, optionally adds a structured AI assessment, maps impacts to current portfolio categories, and checks later market prices for confirmation.

The page defaults to actionable and meaningful context, with separate views for portfolio exposure and all stored headlines. Exposure relevance does not imply a positive or negative forecast, and market reaction displays `Not evaluated` when no directional prediction exists.

1. Apply the News & Events migration.
2. Run `python news_event_engine.py --config config.json --preview` in the analyser to inspect a local report without publishing or emailing.
3. Run without `--preview` to publish the first event history.
4. Open **News & Events** to tune alert thresholds and label reviewed events as correct, partial, false positive, or unverifiable.
5. Let the hourly workflow collect history for several weeks before judging precision.

This feed cannot alter Market Intelligence scores, SIP recommendations, Swing candidates, holdings, or trades. Full JSON backup/restore includes its articles, event clusters, evidence, reactions, alerts, and evaluations.

## Monthly workflow

1. Update each holding's current native value.
2. Open Monthly Review.
3. Confirm the actual contribution for each category. For USD categories, confirm the conversion rate, USD received, and closing USD/INR rate.
4. Save the review, then create the month's snapshot. A normal snapshot requires one current-month review row for every category; creating one without complete review requires an explicit acknowledgement and is marked that way in history.

Before investing, the Targets page can calculate how the available new money would be distributed across underweight categories. The active SIP total is used as the default budget and can be changed for a one-off contribution.

Planned SIP values are only prefills; they are not counted as invested until confirmed in Monthly Review. Planned amounts are stored as whole rupees. Category names are presentation labels; the category investment role controls analyser behavior such as the debt floor.

Suggested-versus-actual monthly comparisons require a successful published run for the current India month using a supported analyzer contract. Failed, partial, stale-month, unpublished, and unsupported runs remain in history but cannot prefill a monthly recommendation.

## Data safety

- CSV is available for convenient editing and individual exports.
- Full JSON is the complete restore format, including archived records, notes, snapshots, category configuration, monthly performance, signal mappings, signal history, recommendations, News & Events evidence, technical watchlist outcomes, and terminal broker execution/realization evidence.
- Full restore and replace imports run as database transactions.
- Permanent deletion is limited to the Archive page and requires confirmation.
- Analyzer-authored runs, candidates, trades, news evidence and alerts are read-only to the browser. User actions such as confirming a fill, updating a stop, recording an exit, reviewing news, acknowledging an alert, or saving a decision use narrowly scoped database functions.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
