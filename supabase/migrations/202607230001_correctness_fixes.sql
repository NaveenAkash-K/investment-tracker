begin;

alter table public.monthly_category_performance
    add column if not exists period_months integer not null default 1
    check (period_months >= 1);

alter table public.swing_candidates
    add column if not exists risk_percentage_used numeric
    check (risk_percentage_used is null or (risk_percentage_used > 0 and risk_percentage_used <= 5));

create or replace function public.validate_holding_tracking_currency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_tracking_currency text;
begin
    select tracking_currency
    into v_tracking_currency
    from public.asset_categories
    where id = new.category_id
      and user_id = new.user_id;

    if v_tracking_currency is null then
        raise exception 'Invalid asset category.';
    end if;
    if new.currency <> v_tracking_currency then
        raise exception 'Holding currency % must match category tracking currency %.', new.currency, v_tracking_currency;
    end if;
    if new.currency = 'INR' then
        new.exchange_rate_to_inr := 1;
    end if;
    return new;
end;
$$;

drop trigger if exists holdings_validate_tracking_currency on public.holdings;
create trigger holdings_validate_tracking_currency
before insert or update of category_id, currency, exchange_rate_to_inr
on public.holdings
for each row execute function public.validate_holding_tracking_currency();

create or replace function public.prevent_incompatible_category_currency()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.tracking_currency <> old.tracking_currency
       and exists (
           select 1
           from public.holdings
           where user_id = new.user_id
             and category_id = new.id
             and currency <> new.tracking_currency
       )
    then
        raise exception 'Change or move linked holdings before changing the category tracking currency.';
    end if;
    return new;
end;
$$;

drop trigger if exists asset_categories_prevent_incompatible_currency on public.asset_categories;
create trigger asset_categories_prevent_incompatible_currency
before update of tracking_currency
on public.asset_categories
for each row execute function public.prevent_incompatible_category_currency();

create or replace function public.save_monthly_category_performance(
    p_month date,
    p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_category_id uuid;
    v_currency text;
    v_previous public.monthly_category_performance%rowtype;
    v_has_previous boolean;
    v_period_months integer;
    v_contribution_inr numeric;
    v_contribution_native numeric;
    v_contribution_fx numeric;
    v_closing_native numeric;
    v_closing_fx numeric;
    v_opening_native numeric;
    v_opening_fx numeric;
    v_opening_inr numeric;
    v_closing_inr numeric;
    v_market_native numeric;
    v_market_inr numeric;
    v_currency_inr numeric;
    v_combined_inr numeric;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
    if p_month <> date_trunc('month', p_month)::date then
        raise exception 'Performance month must be the first day of a month.';
    end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'At least one category is required.';
    end if;
    if exists (
        select 1
        from public.holdings holding
        join public.asset_categories category
          on category.id = holding.category_id
         and category.user_id = holding.user_id
        where holding.user_id = v_user_id
          and holding.is_active = true
          and holding.currency <> category.tracking_currency
    ) then
        raise exception 'One or more active holdings do not match their category tracking currency. Fix them before saving Monthly Review.';
    end if;

    for v_row in select value from jsonb_array_elements(p_rows)
    loop
        v_category_id := (v_row->>'category_id')::uuid;

        select tracking_currency
        into v_currency
        from public.asset_categories
        where id = v_category_id
          and user_id = v_user_id;

        if v_currency is null then
            raise exception 'Invalid category.';
        end if;

        v_contribution_inr := coalesce((v_row->>'contribution_inr')::numeric, 0);
        v_closing_native := coalesce((v_row->>'closing_native_value')::numeric, 0);
        v_contribution_fx := case
            when v_currency = 'INR' then 1
            else coalesce((v_row->>'contribution_fx_rate')::numeric, 0)
        end;
        v_closing_fx := case
            when v_currency = 'INR' then 1
            else coalesce((v_row->>'closing_fx_rate')::numeric, 0)
        end;
        v_contribution_native := case
            when v_currency = 'INR' then v_contribution_inr
            when nullif(v_row->>'contribution_native', '') is not null
                then (v_row->>'contribution_native')::numeric
            when v_contribution_inr = 0 then 0
            else v_contribution_inr / nullif(v_contribution_fx, 0)
        end;

        if v_contribution_inr < 0 or v_contribution_native < 0 or v_closing_native < 0 then
            raise exception 'Amounts cannot be negative.';
        end if;
        if v_contribution_fx <= 0 or v_closing_fx <= 0 then
            raise exception 'Exchange rates must be greater than zero.';
        end if;

        select *
        into v_previous
        from public.monthly_category_performance
        where user_id = v_user_id
          and category_id = v_category_id
          and performance_month < p_month
        order by performance_month desc
        limit 1;

        v_has_previous := found;
        v_period_months := case
            when not v_has_previous then 1
            else greatest(
                1,
                (
                    extract(year from age(p_month, v_previous.performance_month))::integer * 12
                    + extract(month from age(p_month, v_previous.performance_month))::integer
                )
            )
        end;

        if not v_has_previous then
            v_opening_native := v_closing_native;
            v_opening_fx := v_closing_fx;
            v_opening_inr := v_closing_native * v_closing_fx;
            v_closing_inr := v_opening_inr;
            v_market_native := 0;
            v_market_inr := 0;
            v_currency_inr := 0;
            v_combined_inr := 0;
        else
            v_opening_native := v_previous.closing_native_value;
            v_opening_fx := v_previous.closing_fx_rate;
            v_opening_inr := v_opening_native * v_opening_fx;
            v_closing_inr := v_closing_native * v_closing_fx;
            v_market_native := v_closing_native - v_opening_native - v_contribution_native;
            v_market_inr := v_market_native * v_closing_fx;
            v_currency_inr := case
                when v_currency = 'INR' then 0
                else
                    (v_opening_native * (v_closing_fx - v_opening_fx))
                    + (v_contribution_native * (v_closing_fx - v_contribution_fx))
            end;
            v_combined_inr := v_market_inr + v_currency_inr;
        end if;

        insert into public.monthly_category_performance (
            user_id, category_id, performance_month, tracking_currency,
            is_baseline, period_months, opening_native_value, opening_fx_rate,
            contribution_inr, contribution_native, contribution_fx_rate,
            closing_native_value, closing_fx_rate, opening_value_inr,
            closing_value_inr, market_gain_native, market_gain_inr,
            currency_gain_inr, combined_gain_inr
        ) values (
            v_user_id, v_category_id, p_month, v_currency,
            not v_has_previous, v_period_months, v_opening_native, v_opening_fx,
            v_contribution_inr, v_contribution_native, v_contribution_fx,
            v_closing_native, v_closing_fx, v_opening_inr,
            v_closing_inr, v_market_native, v_market_inr,
            v_currency_inr, v_combined_inr
        )
        on conflict (user_id, category_id, performance_month)
        do update set
            tracking_currency = excluded.tracking_currency,
            is_baseline = excluded.is_baseline,
            period_months = excluded.period_months,
            opening_native_value = excluded.opening_native_value,
            opening_fx_rate = excluded.opening_fx_rate,
            contribution_inr = excluded.contribution_inr,
            contribution_native = excluded.contribution_native,
            contribution_fx_rate = excluded.contribution_fx_rate,
            closing_native_value = excluded.closing_native_value,
            closing_fx_rate = excluded.closing_fx_rate,
            opening_value_inr = excluded.opening_value_inr,
            closing_value_inr = excluded.closing_value_inr,
            market_gain_native = excluded.market_gain_native,
            market_gain_inr = excluded.market_gain_inr,
            currency_gain_inr = excluded.currency_gain_inr,
            combined_gain_inr = excluded.combined_gain_inr;

        if v_currency = 'USD' then
            update public.holdings
            set exchange_rate_to_inr = v_closing_fx,
                last_updated_at = (now() at time zone 'Asia/Kolkata')::date
            where user_id = v_user_id
              and category_id = v_category_id
              and currency = 'USD'
              and is_active = true;
        end if;
    end loop;
end;
$$;

do $$
begin
    if to_regprocedure('public.create_current_month_snapshot_v1()') is null then
        execute 'alter function public.create_current_month_snapshot() rename to create_current_month_snapshot_v1';
    end if;
end;
$$;

create or replace function public.create_current_month_snapshot()
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_month date := date_trunc('month', now() at time zone 'Asia/Kolkata')::date;
    v_snapshot_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    if exists (
        select 1
        from public.monthly_category_performance performance
        left join (
            select category_id, sum(current_value_inr) amount_inr
            from public.holdings
            where user_id = v_user_id and is_active = true
            group by category_id
        ) holdings on holdings.category_id = performance.category_id
        where performance.user_id = v_user_id
          and performance.performance_month = v_month
          and abs(performance.closing_value_inr - coalesce(holdings.amount_inr, 0)) > 1
    ) then
        raise exception 'Holdings changed after Monthly Review. Save Monthly Review again before creating the snapshot.';
    end if;

    select public.create_current_month_snapshot_v1() into v_snapshot_id;
    return v_snapshot_id;
end;
$$;

create or replace function public.ingest_swing_lab_scan(p_user_id uuid, p_scan jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_row jsonb;
begin
    perform public.ingest_swing_lab_scan_v1(p_user_id, p_scan);

    update public.swing_scan_runs
    set raw_market_regime = coalesce(nullif(p_scan->>'raw_market_regime', ''), p_scan->>'market_regime', 'UNKNOWN'),
        regime_confirmed = coalesce((p_scan->>'regime_confirmed')::boolean, false),
        regime_reason = nullif(p_scan->>'regime_reason', ''),
        regime_confirmation_reason = nullif(p_scan->>'regime_confirmation_reason', ''),
        benchmark_sma50 = nullif(p_scan->>'benchmark_sma50', '')::numeric,
        benchmark_sma200 = nullif(p_scan->>'benchmark_sma200', '')::numeric,
        benchmark_distance_200_percentage = nullif(p_scan->>'benchmark_distance_200_percentage', '')::numeric,
        benchmark_price_date = nullif(p_scan->>'benchmark_price_date', '')::date,
        breadth_available = coalesce((p_scan->>'breadth_available')::integer, 0),
        breadth_coverage_percentage = nullif(p_scan->>'breadth_coverage_percentage', '')::numeric,
        published_size = coalesce((p_scan->>'published_size')::integer, 0),
        effective_minimum_score = nullif(p_scan->>'effective_minimum_score', '')::numeric,
        effective_risk_percentage = nullif(p_scan->>'effective_risk_percentage', '')::numeric,
        scan_blocked_reason = nullif(p_scan->>'scan_blocked_reason', ''),
        gate_counts = coalesce(p_scan->'gate_counts', '{}'::jsonb)
    where id = (p_scan->>'scan_id')::uuid
      and user_id = p_user_id;

    for v_row in select value from jsonb_array_elements(coalesce(p_scan->'candidates', '[]'::jsonb))
    loop
        update public.swing_candidates
        set risk_percentage_used = nullif(v_row->>'risk_percentage_used', '')::numeric
        where user_id = p_user_id
          and signal_key = v_row->>'signal_key';
    end loop;
end;
$$;

create or replace function public.confirm_swing_entry(
    p_candidate_id uuid,
    p_entry_date date,
    p_entry_price numeric,
    p_quantity integer,
    p_trade_mode text,
    p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_candidate public.swing_candidates%rowtype;
    v_settings public.swing_lab_settings%rowtype;
    v_trade_id uuid;
    v_risk_per_share numeric;
    v_planned_risk numeric;
    v_risk_budget numeric;
    v_slot_capital numeric;
    v_deployed_capital numeric;
    v_open_count integer;
    v_sector_count integer;
    v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_entry_price <= 0 or p_quantity <= 0 then raise exception 'Entry price and quantity must be positive.'; end if;
    if p_trade_mode not in ('paper', 'live') then raise exception 'Trade mode must be paper or live.'; end if;
    if p_entry_date > v_today then raise exception 'Entry date cannot be in the future.'; end if;

    select * into v_settings
    from public.swing_lab_settings
    where user_id = v_user_id
    for update;
    if not found then raise exception 'Save Swing Lab risk settings before confirming an entry.'; end if;

    perform 1
    from public.swing_trades
    where user_id = v_user_id and status in ('open', 'exit_pending')
    for update;

    select * into v_candidate
    from public.swing_candidates
    where id = p_candidate_id and user_id = v_user_id
    for update;

    if not found then raise exception 'Candidate not found.'; end if;
    if v_candidate.status not in ('candidate', 'ready', 'triggered') then raise exception 'This candidate can no longer be entered.'; end if;
    if p_entry_date < v_candidate.setup_as_of or p_entry_date > v_candidate.expires_on then
        raise exception 'Actual entry date must be inside the candidate entry window.';
    end if;
    if p_entry_price > v_candidate.maximum_entry then
        raise exception 'Actual entry is above the maximum acceptable price. Skip this candidate instead of chasing it.';
    end if;
    if v_candidate.suggested_quantity <= 0 or p_quantity > v_candidate.suggested_quantity then
        raise exception 'Quantity cannot exceed the risk-controlled suggested quantity.';
    end if;

    v_risk_per_share := p_entry_price - v_candidate.initial_stop;
    if v_risk_per_share <= 0 then raise exception 'Actual entry must be above the initial stop.'; end if;
    v_planned_risk := v_risk_per_share * p_quantity;
    v_risk_budget := v_settings.trading_capital_inr
        * coalesce(v_candidate.risk_percentage_used, v_settings.risk_per_trade_percentage)
        / 100;
    v_slot_capital := v_settings.trading_capital_inr / greatest(v_settings.max_open_positions, 1);

    select count(*), coalesce(sum(entry_price * quantity), 0)
    into v_open_count, v_deployed_capital
    from public.swing_trades
    where user_id = v_user_id
      and status in ('open', 'exit_pending');

    select count(*)
    into v_sector_count
    from public.swing_trades
    where user_id = v_user_id
      and status in ('open', 'exit_pending')
      and coalesce(sector, 'Unclassified') = coalesce(v_candidate.sector, 'Unclassified');

    if v_open_count >= v_settings.max_open_positions then
        raise exception 'Maximum open positions is already in use.';
    end if;
    if v_sector_count >= v_settings.max_sector_positions then
        raise exception 'Maximum positions for this sector is already in use.';
    end if;
    if v_planned_risk > v_risk_budget + 0.01 then
        raise exception 'Actual fill would risk % INR, above the current % INR risk budget.',
            round(v_planned_risk, 2), round(v_risk_budget, 2);
    end if;
    if p_entry_price * p_quantity > v_slot_capital + 0.01 then
        raise exception 'Actual fill exceeds the configured capital available per position.';
    end if;
    if v_deployed_capital + p_entry_price * p_quantity > v_settings.trading_capital_inr + 0.01 then
        raise exception 'Actual fill would exceed total Swing Lab trading capital.';
    end if;

    insert into public.swing_trades(
        user_id, candidate_id, symbol, company_name, sector, trade_mode,
        signal_entry, maximum_entry, entry_date, entry_price, quantity,
        initial_stop, current_stop, initial_risk_per_share, planned_risk_inr,
        current_price, current_price_as_of, highest_close, unrealized_pnl_inr,
        unrealized_r_multiple, notes
    ) values (
        v_user_id, v_candidate.id, v_candidate.symbol, v_candidate.company_name,
        v_candidate.sector, p_trade_mode, v_candidate.entry_trigger, v_candidate.maximum_entry,
        p_entry_date, p_entry_price, p_quantity, v_candidate.initial_stop,
        v_candidate.initial_stop, v_risk_per_share, v_planned_risk,
        p_entry_price, p_entry_date, p_entry_price, 0, 0, nullif(trim(p_notes), '')
    ) returning id into v_trade_id;

    update public.swing_candidates
    set status = 'entered'
    where id = v_candidate.id and user_id = v_user_id;

    insert into public.swing_trade_events(user_id, trade_id, event_type, price, stop_price, reason)
    values (v_user_id, v_trade_id, 'entry_confirmed', p_entry_price, v_candidate.initial_stop, 'Actual entry confirmed by user');

    return v_trade_id;
end;
$$;

create or replace function public.restore_swing_lab_v2_details(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'swing_scan_runs', '[]'::jsonb))
    loop
        update public.swing_scan_runs
        set raw_market_regime = coalesce(nullif(v_row->>'raw_market_regime', ''), v_row->>'market_regime', 'UNKNOWN'),
            regime_confirmed = coalesce((v_row->>'regime_confirmed')::boolean, false),
            regime_reason = nullif(v_row->>'regime_reason', ''),
            regime_confirmation_reason = nullif(v_row->>'regime_confirmation_reason', ''),
            benchmark_sma50 = nullif(v_row->>'benchmark_sma50', '')::numeric,
            benchmark_sma200 = nullif(v_row->>'benchmark_sma200', '')::numeric,
            benchmark_distance_200_percentage = nullif(v_row->>'benchmark_distance_200_percentage', '')::numeric,
            benchmark_price_date = nullif(v_row->>'benchmark_price_date', '')::date,
            breadth_available = coalesce((v_row->>'breadth_available')::integer, 0),
            breadth_coverage_percentage = nullif(v_row->>'breadth_coverage_percentage', '')::numeric,
            published_size = coalesce((v_row->>'published_size')::integer, 0),
            effective_minimum_score = nullif(v_row->>'effective_minimum_score', '')::numeric,
            effective_risk_percentage = nullif(v_row->>'effective_risk_percentage', '')::numeric,
            scan_blocked_reason = nullif(v_row->>'scan_blocked_reason', ''),
            gate_counts = coalesce(v_row->'gate_counts', '{}'::jsonb)
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'swing_candidates', '[]'::jsonb))
    loop
        update public.swing_candidates
        set risk_percentage_used = nullif(v_row->>'risk_percentage_used', '')::numeric
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v4(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_base_backup jsonb;
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2)
    then
        raise exception 'Unsupported backup format';
    end if;

    -- The original base restore predates the integrated tables and validates
    -- version 1. Extended restore functions consume the same data object, so
    -- only the compatibility marker is changed for the internal call.
    v_base_backup := jsonb_set(p_backup, '{version}', '1'::jsonb, true);
    perform public.restore_complete_portfolio_backup_v3(v_base_backup);
    perform public.restore_swing_lab_v2_details(p_backup);

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'monthly_category_performance', '[]'::jsonb))
    loop
        update public.monthly_category_performance
        set period_months = greatest(1, coalesce((v_row->>'period_months')::integer, 1))
        where user_id = v_user_id
          and category_id = (v_row->>'category_id')::uuid
          and performance_month = (v_row->>'performance_month')::date;
    end loop;
end;
$$;

revoke all on function public.ingest_swing_lab_scan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_swing_lab_scan(uuid, jsonb) to service_role;

revoke all on function public.create_current_month_snapshot() from public, anon;
grant execute on function public.create_current_month_snapshot() to authenticated;

revoke all on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) from public, anon;
grant execute on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) to authenticated;

revoke all on function public.restore_complete_portfolio_backup_v4(jsonb) from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v4(jsonb) to authenticated;

commit;
