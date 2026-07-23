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
3. For a new Supabase project, apply every SQL file in `supabase/migrations` in filename order, starting with [the initial schema](supabase/migrations/202607190001_initial_schema.sql). For an existing installation, apply only migrations newer than the last one already run. The current final migration is [the correctness migration](supabase/migrations/202607230001_correctness_fixes.sql).
4. Run `npm run dev` and open `http://localhost:3000`.

The migration is transactional. It adds monthly performance storage, archive-safe category behavior, single-current-note enforcement, and database functions used for atomic imports, bulk edits, snapshots, targets, categories, and full restores.

## Market Intelligence integration

The companion analyser in `D:\Projects\Personal\market-analyser` can read the tracker's current holdings, targets and SIP plans, then publish daily alerts, weekly reports and monthly bounded SIP suggestions back to this app.

1. Apply the Market Intelligence migration listed above.
2. Open **Market Intelligence → Configure signal mappings** and map every active SIP plan to one or more supported market keys. Category mappings improve portfolio-fit scoring.
3. On the analyser machine, set `INVESTMENT_TRACKER_SUPABASE_URL`, `INVESTMENT_TRACKER_SUPABASE_SERVICE_ROLE_KEY` and `INVESTMENT_TRACKER_USER_ID` as server-side environment variables.
4. Set `supabase.enabled` to `true` in the analyser config and run a preview before scheduling it.

The service-role key must never be placed in `.env.local`, browser code or any public client bundle. Market recommendations remain advisory: Monthly Review records the actual amount invested and remains the source of truth.

## Swing Lab workflow

Swing Lab is a separate risk budget and journal for end-of-day Indian-equity swing trades. It does not change long-term holdings, SIP allocations, or Monthly Review.

1. Apply both Swing Lab migrations and the final correctness migration. The dedicated weekday Swing Lab workflow runs at 17:30 IST after the Indian session; the 08:00 IST portfolio workflow deliberately skips Swing Lab.
2. Set trading capital, risk per trade, position limits, sector limit, and the minimum setup score in **Swing Lab → Risk controls**. Keep paper mode on while validating the process.
3. A candidate is only a plan. Buy only after its entry trigger trades and never above the displayed maximum-entry price.
4. After an actual or paper fill, confirm its date, price, and quantity in Swing Lab. This is the only action that creates an open trade.
5. The daily analyser updates current price, raises trailing stops without lowering them, and flags exits. Confirm the actual exit fill in the app to close the journal entry.

The scanner is long-only and uses the Nifty 200 universe, liquidity and trend gates, relative strength, a recent-breakout pullback, volatility-sized entries/stops, market breadth, sector caps, and portfolio-level risk limits. RED blocks new candidates. AMBER requires the higher score threshold, halves configured risk, and publishes at most one new candidate. Existing candidates and positions continue to be monitored in every regime. No qualified candidate is a normal result; the application never forces capital into a trade.

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
4. Save the review, then create the month's snapshot.

Before investing, the Targets page can calculate how the available new money would be distributed across underweight categories. The active SIP total is used as the default budget and can be changed for a one-off contribution.

Planned SIP values are only prefills; they are not counted as invested until confirmed in Monthly Review.

## Data safety

- CSV is available for convenient editing and individual exports.
- Full JSON is the complete restore format, including archived records, notes, snapshots, category configuration, monthly performance, signal mappings, signal history, recommendations, News & Events evidence, and alerts.
- Full restore and replace imports run as database transactions.
- Permanent deletion is limited to the Archive page and requires confirmation.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
