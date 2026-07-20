# Investment Tracker

A private, manual portfolio tracker built for a personal INR-based portfolio. It tracks holdings, planned SIPs, target allocation, notes, archives, monthly snapshots, and contribution-adjusted monthly performance.

USD categories separate:

- actual INR contribution;
- market gain or loss in the foreign asset;
- USD/INR appreciation or depreciation;
- combined gain or loss in INR.

The first enhanced monthly review is a baseline. Accurate market and currency attribution starts with the following month; historical snapshots are retained as value-only history.

## Local setup

1. Install packages with `npm install`.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local`.
3. Apply [the portfolio migration](supabase/migrations/202607200001_portfolio_safety_and_performance.sql), followed by [the Market Intelligence migration](supabase/migrations/202607200002_market_intelligence.sql), in the Supabase SQL editor.
4. Run `npm run dev` and open `http://localhost:3000`.

The migration is transactional. It adds monthly performance storage, archive-safe category behavior, single-current-note enforcement, and database functions used for atomic imports, bulk edits, snapshots, targets, categories, and full restores.

## Market Intelligence integration

The companion analyser in `D:\Projects\Personal\market-analyser` can read the tracker's current holdings, targets and SIP plans, then publish daily alerts, weekly reports and monthly bounded SIP suggestions back to this app.

1. Apply the Market Intelligence migration listed above.
2. Open **Market Intelligence → Configure signal mappings** and map every active SIP plan to one or more supported market keys. Category mappings improve portfolio-fit scoring.
3. On the analyser machine, set `INVESTMENT_TRACKER_SUPABASE_URL`, `INVESTMENT_TRACKER_SUPABASE_SERVICE_ROLE_KEY` and `INVESTMENT_TRACKER_USER_ID` as server-side environment variables.
4. Set `supabase.enabled` to `true` in the analyser config and run a preview before scheduling it.

The service-role key must never be placed in `.env.local`, browser code or any public client bundle. Market recommendations remain advisory: Monthly Review records the actual amount invested and remains the source of truth.

## Monthly workflow

1. Update each holding's current native value.
2. Open Monthly Review.
3. Confirm the actual contribution for each category. For USD categories, confirm the conversion rate, USD received, and closing USD/INR rate.
4. Save the review, then create the month's snapshot.

Planned SIP values are only prefills; they are not counted as invested until confirmed in Monthly Review.

## Data safety

- CSV is available for convenient editing and individual exports.
- Full JSON is the complete restore format, including archived records, notes, snapshots, category configuration, monthly performance, signal mappings, signal history, recommendations, and alerts.
- Full restore and replace imports run as database transactions.
- Permanent deletion is limited to the Archive page and requires confirmation.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
