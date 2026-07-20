begin;

create table if not exists public.swing_lab_settings (
    user_id uuid primary key references auth.users(id) on delete cascade,
    trading_capital_inr numeric not null default 100000 check (trading_capital_inr >= 0),
    risk_per_trade_percentage numeric not null default 0.5 check (risk_per_trade_percentage > 0 and risk_per_trade_percentage <= 5),
    max_open_positions integer not null default 5 check (max_open_positions between 1 and 20),
    max_sector_positions integer not null default 2 check (max_sector_positions between 1 and 10),
    minimum_setup_score numeric not null default 70 check (minimum_setup_score between 0 and 100),
    paper_mode boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.swing_scan_runs (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    as_of timestamptz not null,
    status text not null check (status in ('successful', 'partial', 'failed')),
    model_version text not null,
    market_regime text not null check (market_regime in ('GREEN', 'NEUTRAL', 'RED', 'UNKNOWN')),
    benchmark_symbol text,
    benchmark_close numeric,
    breadth_percentage numeric,
    universe_size integer not null default 0,
    eligible_size integer not null default 0,
    data_issues jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    unique (user_id, id)
);

create index if not exists swing_scan_runs_user_as_of_idx
    on public.swing_scan_runs(user_id, as_of desc);

create table if not exists public.swing_candidates (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    scan_id uuid not null references public.swing_scan_runs(id) on delete cascade,
    signal_key text not null,
    symbol text not null,
    company_name text not null,
    sector text,
    setup_type text not null default 'TREND_PULLBACK',
    status text not null default 'ready' check (status in ('candidate', 'ready', 'triggered', 'entered', 'skipped', 'expired', 'invalidated')),
    setup_score numeric not null check (setup_score between 0 and 100),
    setup_as_of date not null,
    expires_on date not null,
    market_regime text not null default 'UNKNOWN',
    close_price numeric not null check (close_price > 0),
    entry_trigger numeric not null check (entry_trigger > 0),
    maximum_entry numeric not null check (maximum_entry >= entry_trigger),
    initial_stop numeric not null check (initial_stop > 0),
    atr numeric not null check (atr > 0),
    risk_per_share numeric not null check (risk_per_share > 0),
    reward_risk_ratio numeric,
    suggested_quantity integer not null default 0 check (suggested_quantity >= 0),
    suggested_risk_inr numeric not null default 0 check (suggested_risk_inr >= 0),
    last_price numeric,
    last_price_as_of date,
    score_components jsonb not null default '{}'::jsonb,
    reasons jsonb not null default '[]'::jsonb,
    invalidation_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, signal_key)
);

create index if not exists swing_candidates_user_status_idx
    on public.swing_candidates(user_id, status, setup_as_of desc);

create table if not exists public.swing_trades (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    candidate_id uuid references public.swing_candidates(id) on delete set null,
    symbol text not null,
    company_name text not null,
    sector text,
    trade_mode text not null check (trade_mode in ('paper', 'live')),
    status text not null default 'open' check (status in ('open', 'exit_pending', 'closed')),
    signal_entry numeric not null check (signal_entry > 0),
    maximum_entry numeric not null check (maximum_entry >= signal_entry),
    entry_date date not null,
    entry_price numeric not null check (entry_price > 0),
    quantity integer not null check (quantity > 0),
    initial_stop numeric not null check (initial_stop > 0),
    current_stop numeric not null check (current_stop > 0),
    initial_risk_per_share numeric not null check (initial_risk_per_share > 0),
    planned_risk_inr numeric not null check (planned_risk_inr > 0),
    current_price numeric,
    current_price_as_of date,
    highest_close numeric,
    unrealized_pnl_inr numeric,
    unrealized_r_multiple numeric,
    exit_signal_reason text,
    exit_signal_at timestamptz,
    exit_date date,
    exit_price numeric,
    fees_inr numeric not null default 0 check (fees_inr >= 0),
    realized_pnl_inr numeric,
    realized_r_multiple numeric,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists swing_trades_candidate_unique_idx
    on public.swing_trades(user_id, candidate_id)
    where candidate_id is not null;

create index if not exists swing_trades_user_status_idx
    on public.swing_trades(user_id, status, entry_date desc);

create table if not exists public.swing_trade_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    trade_id uuid not null references public.swing_trades(id) on delete cascade,
    event_type text not null check (event_type in ('entry_confirmed', 'stop_updated', 'exit_signaled', 'exit_confirmed', 'note')),
    event_at timestamptz not null default now(),
    price numeric,
    stop_price numeric,
    reason text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists swing_trade_events_trade_idx
    on public.swing_trade_events(user_id, trade_id, event_at desc);

alter table public.swing_lab_settings enable row level security;
alter table public.swing_scan_runs enable row level security;
alter table public.swing_candidates enable row level security;
alter table public.swing_trades enable row level security;
alter table public.swing_trade_events enable row level security;

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'swing_lab_settings', 'swing_scan_runs', 'swing_candidates',
        'swing_trades', 'swing_trade_events'
    ] loop
        execute format('drop policy if exists "Users manage %1$s" on public.%1$I', table_name);
        execute format(
            'create policy "Users manage %1$s" on public.%1$I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
            table_name
        );
    end loop;
end;
$$;

drop trigger if exists swing_lab_settings_set_updated_at on public.swing_lab_settings;
create trigger swing_lab_settings_set_updated_at
before update on public.swing_lab_settings
for each row execute function public.set_updated_at();

drop trigger if exists swing_candidates_set_updated_at on public.swing_candidates;
create trigger swing_candidates_set_updated_at
before update on public.swing_candidates
for each row execute function public.set_updated_at();

drop trigger if exists swing_trades_set_updated_at on public.swing_trades;
create trigger swing_trades_set_updated_at
before update on public.swing_trades
for each row execute function public.set_updated_at();

insert into public.swing_lab_settings(user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.ingest_swing_lab_scan(p_user_id uuid, p_scan jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_scan_id uuid := (p_scan->>'scan_id')::uuid;
    v_as_of timestamptz := (p_scan->>'as_of')::timestamptz;
    v_row jsonb;
    v_trade public.swing_trades%rowtype;
    v_old_stop numeric;
    v_new_stop numeric;
    v_old_status text;
    v_new_status text;
begin
    if p_user_id is null or v_scan_id is null then
        raise exception 'User id and scan id are required.';
    end if;

    insert into public.swing_scan_runs(
        id, user_id, as_of, status, model_version, market_regime,
        benchmark_symbol, benchmark_close, breadth_percentage,
        universe_size, eligible_size, data_issues
    ) values (
        v_scan_id, p_user_id, v_as_of, p_scan->>'status', p_scan->>'model_version',
        coalesce(p_scan->>'market_regime', 'UNKNOWN'), p_scan->>'benchmark_symbol',
        nullif(p_scan->>'benchmark_close', '')::numeric,
        nullif(p_scan->>'breadth_percentage', '')::numeric,
        coalesce((p_scan->>'universe_size')::integer, 0),
        coalesce((p_scan->>'eligible_size')::integer, 0),
        coalesce(p_scan->'data_issues', '[]'::jsonb)
    ) on conflict (id) do update set
        status = excluded.status,
        market_regime = excluded.market_regime,
        benchmark_close = excluded.benchmark_close,
        breadth_percentage = excluded.breadth_percentage,
        universe_size = excluded.universe_size,
        eligible_size = excluded.eligible_size,
        data_issues = excluded.data_issues;

    update public.swing_candidates
    set status = 'expired', invalidation_reason = 'Entry window expired.'
    where user_id = p_user_id
      and status in ('candidate', 'ready', 'triggered')
      and expires_on < v_as_of::date;

    for v_row in select value from jsonb_array_elements(coalesce(p_scan->'candidates', '[]'::jsonb))
    loop
        insert into public.swing_candidates(
            id, user_id, scan_id, signal_key, symbol, company_name, sector,
            setup_type, status, setup_score, setup_as_of, expires_on, market_regime,
            close_price, entry_trigger, maximum_entry, initial_stop, atr,
            risk_per_share, reward_risk_ratio, suggested_quantity, suggested_risk_inr,
            last_price, last_price_as_of, score_components, reasons, invalidation_reason
        ) values (
            (v_row->>'id')::uuid, p_user_id, v_scan_id, v_row->>'signal_key',
            upper(v_row->>'symbol'), coalesce(v_row->>'company_name', upper(v_row->>'symbol')),
            nullif(v_row->>'sector', ''), coalesce(v_row->>'setup_type', 'TREND_PULLBACK'),
            coalesce(v_row->>'status', 'ready'), (v_row->>'setup_score')::numeric,
            (v_row->>'setup_as_of')::date, (v_row->>'expires_on')::date,
            coalesce(v_row->>'market_regime', 'UNKNOWN'), (v_row->>'close_price')::numeric,
            (v_row->>'entry_trigger')::numeric, (v_row->>'maximum_entry')::numeric,
            (v_row->>'initial_stop')::numeric, (v_row->>'atr')::numeric,
            (v_row->>'risk_per_share')::numeric, nullif(v_row->>'reward_risk_ratio', '')::numeric,
            coalesce((v_row->>'suggested_quantity')::integer, 0),
            coalesce((v_row->>'suggested_risk_inr')::numeric, 0),
            nullif(v_row->>'last_price', '')::numeric,
            nullif(v_row->>'last_price_as_of', '')::date,
            coalesce(v_row->'score_components', '{}'::jsonb),
            coalesce(v_row->'reasons', '[]'::jsonb), nullif(v_row->>'invalidation_reason', '')
        ) on conflict (user_id, signal_key) do update set
            scan_id = excluded.scan_id,
            status = case
                when public.swing_candidates.status in ('entered', 'skipped') then public.swing_candidates.status
                else excluded.status
            end,
            setup_score = excluded.setup_score,
            close_price = excluded.close_price,
            last_price = excluded.last_price,
            last_price_as_of = excluded.last_price_as_of,
            score_components = excluded.score_components,
            reasons = excluded.reasons,
            invalidation_reason = excluded.invalidation_reason;
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_scan->'candidate_updates', '[]'::jsonb))
    loop
        update public.swing_candidates
        set status = coalesce(v_row->>'status', status),
            last_price = coalesce(nullif(v_row->>'last_price', '')::numeric, last_price),
            last_price_as_of = coalesce(nullif(v_row->>'last_price_as_of', '')::date, last_price_as_of),
            invalidation_reason = case
                when v_row->>'status' in ('invalidated', 'expired') then coalesce(nullif(v_row->>'reason', ''), invalidation_reason)
                else invalidation_reason
            end
        where user_id = p_user_id
          and signal_key = v_row->>'signal_key'
          and status not in ('entered', 'skipped');
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_scan->'position_updates', '[]'::jsonb))
    loop
        select * into v_trade
        from public.swing_trades
        where id = (v_row->>'trade_id')::uuid
          and user_id = p_user_id
          and status in ('open', 'exit_pending')
        for update;

        if not found then continue; end if;

        v_old_stop := v_trade.current_stop;
        v_old_status := v_trade.status;
        v_new_stop := greatest(v_trade.current_stop, coalesce(nullif(v_row->>'current_stop', '')::numeric, v_trade.current_stop));
        v_new_status := case when coalesce((v_row->>'exit_pending')::boolean, false) then 'exit_pending' else v_trade.status end;

        update public.swing_trades
        set current_stop = v_new_stop,
            current_price = coalesce(nullif(v_row->>'current_price', '')::numeric, current_price),
            current_price_as_of = coalesce(nullif(v_row->>'current_price_as_of', '')::date, current_price_as_of),
            highest_close = greatest(coalesce(highest_close, entry_price), coalesce(nullif(v_row->>'highest_close', '')::numeric, entry_price)),
            unrealized_pnl_inr = coalesce(nullif(v_row->>'unrealized_pnl_inr', '')::numeric, unrealized_pnl_inr),
            unrealized_r_multiple = coalesce(nullif(v_row->>'unrealized_r_multiple', '')::numeric, unrealized_r_multiple),
            status = v_new_status,
            exit_signal_reason = case when v_new_status = 'exit_pending' then nullif(v_row->>'exit_reason', '') else exit_signal_reason end,
            exit_signal_at = case when v_new_status = 'exit_pending' and v_old_status <> 'exit_pending' then v_as_of else exit_signal_at end
        where id = v_trade.id and user_id = p_user_id;

        if v_new_stop > v_old_stop then
            insert into public.swing_trade_events(user_id, trade_id, event_type, event_at, price, stop_price, reason)
            values (p_user_id, v_trade.id, 'stop_updated', v_as_of,
                nullif(v_row->>'current_price', '')::numeric, v_new_stop, 'Analyzer trailing-stop update');
        end if;

        if v_new_status = 'exit_pending' and v_old_status <> 'exit_pending' then
            insert into public.swing_trade_events(user_id, trade_id, event_type, event_at, price, stop_price, reason)
            values (p_user_id, v_trade.id, 'exit_signaled', v_as_of,
                nullif(v_row->>'current_price', '')::numeric, v_new_stop, nullif(v_row->>'exit_reason', ''));
        end if;
    end loop;
end;
$$;

create or replace function public.save_swing_lab_settings(
    p_trading_capital_inr numeric,
    p_risk_per_trade_percentage numeric,
    p_max_open_positions integer,
    p_max_sector_positions integer,
    p_minimum_setup_score numeric,
    p_paper_mode boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_trading_capital_inr < 0 then raise exception 'Trading capital cannot be negative.'; end if;
    if p_risk_per_trade_percentage <= 0 or p_risk_per_trade_percentage > 5 then raise exception 'Risk per trade must be between 0 and 5 percent.'; end if;
    if p_max_open_positions < 1 or p_max_open_positions > 20 then raise exception 'Maximum open positions must be between 1 and 20.'; end if;
    if p_max_sector_positions < 1 or p_max_sector_positions > 10 then raise exception 'Maximum sector positions must be between 1 and 10.'; end if;
    if p_minimum_setup_score < 0 or p_minimum_setup_score > 100 then raise exception 'Minimum score must be between 0 and 100.'; end if;

    insert into public.swing_lab_settings(
        user_id, trading_capital_inr, risk_per_trade_percentage,
        max_open_positions, max_sector_positions, minimum_setup_score, paper_mode
    ) values (
        v_user_id, p_trading_capital_inr, p_risk_per_trade_percentage,
        p_max_open_positions, p_max_sector_positions, p_minimum_setup_score, p_paper_mode
    ) on conflict (user_id) do update set
        trading_capital_inr = excluded.trading_capital_inr,
        risk_per_trade_percentage = excluded.risk_per_trade_percentage,
        max_open_positions = excluded.max_open_positions,
        max_sector_positions = excluded.max_sector_positions,
        minimum_setup_score = excluded.minimum_setup_score,
        paper_mode = excluded.paper_mode;
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
    v_trade_id uuid;
    v_risk_per_share numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_entry_price <= 0 or p_quantity <= 0 then raise exception 'Entry price and quantity must be positive.'; end if;
    if p_trade_mode not in ('paper', 'live') then raise exception 'Trade mode must be paper or live.'; end if;

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
        v_candidate.initial_stop, v_risk_per_share, v_risk_per_share * p_quantity,
        p_entry_price, p_entry_date, p_entry_price, 0, 0, nullif(trim(p_notes), '')
    ) returning id into v_trade_id;

    update public.swing_candidates set status = 'entered' where id = v_candidate.id and user_id = v_user_id;

    insert into public.swing_trade_events(user_id, trade_id, event_type, price, stop_price, reason)
    values (v_user_id, v_trade_id, 'entry_confirmed', p_entry_price, v_candidate.initial_stop, 'Actual entry confirmed by user');

    return v_trade_id;
end;
$$;

create or replace function public.skip_swing_candidate(p_candidate_id uuid, p_reason text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    update public.swing_candidates
    set status = 'skipped', invalidation_reason = coalesce(nullif(trim(p_reason), ''), 'Skipped by user')
    where id = p_candidate_id and user_id = v_user_id and status in ('candidate', 'ready', 'triggered');
    if not found then raise exception 'Candidate is not available to skip.'; end if;
end;
$$;

create or replace function public.update_swing_trade_stop(p_trade_id uuid, p_new_stop numeric, p_reason text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_trade public.swing_trades%rowtype;
begin
    select * into v_trade from public.swing_trades
    where id = p_trade_id and user_id = v_user_id and status in ('open', 'exit_pending')
    for update;
    if not found then raise exception 'Open trade not found.'; end if;
    if p_new_stop < v_trade.current_stop then raise exception 'A long-trade stop cannot be moved lower.'; end if;
    if p_new_stop = v_trade.current_stop then return; end if;

    update public.swing_trades set current_stop = p_new_stop where id = v_trade.id and user_id = v_user_id;
    insert into public.swing_trade_events(user_id, trade_id, event_type, stop_price, reason)
    values (v_user_id, v_trade.id, 'stop_updated', p_new_stop, coalesce(nullif(trim(p_reason), ''), 'Manual stop update'));
end;
$$;

create or replace function public.confirm_swing_exit(
    p_trade_id uuid,
    p_exit_date date,
    p_exit_price numeric,
    p_fees_inr numeric default 0,
    p_notes text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_trade public.swing_trades%rowtype;
    v_pnl numeric;
    v_r_multiple numeric;
begin
    if p_exit_price <= 0 or p_fees_inr < 0 then raise exception 'Exit price must be positive and fees cannot be negative.'; end if;
    select * into v_trade from public.swing_trades
    where id = p_trade_id and user_id = v_user_id and status in ('open', 'exit_pending')
    for update;
    if not found then raise exception 'Open trade not found.'; end if;
    if p_exit_date < v_trade.entry_date then raise exception 'Exit date cannot be before entry date.'; end if;

    v_pnl := (p_exit_price - v_trade.entry_price) * v_trade.quantity - p_fees_inr;
    v_r_multiple := v_pnl / nullif(v_trade.planned_risk_inr, 0);

    update public.swing_trades
    set status = 'closed', exit_date = p_exit_date, exit_price = p_exit_price,
        fees_inr = p_fees_inr, realized_pnl_inr = v_pnl,
        realized_r_multiple = v_r_multiple, unrealized_pnl_inr = null,
        unrealized_r_multiple = null,
        notes = case when nullif(trim(p_notes), '') is null then notes else concat_ws(E'\n', notes, trim(p_notes)) end
    where id = v_trade.id and user_id = v_user_id;

    insert into public.swing_trade_events(user_id, trade_id, event_type, price, stop_price, reason)
    values (v_user_id, v_trade.id, 'exit_confirmed', p_exit_price, v_trade.current_stop,
        coalesce(v_trade.exit_signal_reason, 'Actual exit confirmed by user'));
end;
$$;

create or replace function public.restore_swing_lab_backup(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_data jsonb := p_backup->'data';
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    delete from public.swing_trade_events where user_id = v_user_id;
    delete from public.swing_trades where user_id = v_user_id;
    delete from public.swing_candidates where user_id = v_user_id;
    delete from public.swing_scan_runs where user_id = v_user_id;
    delete from public.swing_lab_settings where user_id = v_user_id;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'swing_lab_settings', '[]'::jsonb)) loop
        insert into public.swing_lab_settings(user_id, trading_capital_inr, risk_per_trade_percentage,
            max_open_positions, max_sector_positions, minimum_setup_score, paper_mode, created_at, updated_at)
        values (v_user_id, coalesce((v_row->>'trading_capital_inr')::numeric, 100000),
            coalesce((v_row->>'risk_per_trade_percentage')::numeric, 0.5),
            coalesce((v_row->>'max_open_positions')::integer, 5), coalesce((v_row->>'max_sector_positions')::integer, 2),
            coalesce((v_row->>'minimum_setup_score')::numeric, 70), coalesce((v_row->>'paper_mode')::boolean, true),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()), coalesce(nullif(v_row->>'updated_at', '')::timestamptz, now()));
    end loop;
    if not exists (select 1 from public.swing_lab_settings where user_id = v_user_id) then
        insert into public.swing_lab_settings(user_id) values (v_user_id);
    end if;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'swing_scan_runs', '[]'::jsonb)) loop
        insert into public.swing_scan_runs(id, user_id, as_of, status, model_version, market_regime,
            benchmark_symbol, benchmark_close, breadth_percentage, universe_size, eligible_size, data_issues, created_at)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'as_of')::timestamptz, v_row->>'status', v_row->>'model_version',
            v_row->>'market_regime', v_row->>'benchmark_symbol', nullif(v_row->>'benchmark_close', '')::numeric,
            nullif(v_row->>'breadth_percentage', '')::numeric, coalesce((v_row->>'universe_size')::integer, 0),
            coalesce((v_row->>'eligible_size')::integer, 0), coalesce(v_row->'data_issues', '[]'::jsonb),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'swing_candidates', '[]'::jsonb)) loop
        insert into public.swing_candidates(id, user_id, scan_id, signal_key, symbol, company_name, sector, setup_type,
            status, setup_score, setup_as_of, expires_on, market_regime, close_price, entry_trigger, maximum_entry,
            initial_stop, atr, risk_per_share, reward_risk_ratio, suggested_quantity, suggested_risk_inr,
            last_price, last_price_as_of, score_components, reasons, invalidation_reason, created_at, updated_at)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'scan_id')::uuid, v_row->>'signal_key', v_row->>'symbol',
            v_row->>'company_name', v_row->>'sector', v_row->>'setup_type', v_row->>'status', (v_row->>'setup_score')::numeric,
            (v_row->>'setup_as_of')::date, (v_row->>'expires_on')::date, v_row->>'market_regime',
            (v_row->>'close_price')::numeric, (v_row->>'entry_trigger')::numeric, (v_row->>'maximum_entry')::numeric,
            (v_row->>'initial_stop')::numeric, (v_row->>'atr')::numeric, (v_row->>'risk_per_share')::numeric,
            nullif(v_row->>'reward_risk_ratio', '')::numeric, coalesce((v_row->>'suggested_quantity')::integer, 0),
            coalesce((v_row->>'suggested_risk_inr')::numeric, 0), nullif(v_row->>'last_price', '')::numeric,
            nullif(v_row->>'last_price_as_of', '')::date, coalesce(v_row->'score_components', '{}'::jsonb),
            coalesce(v_row->'reasons', '[]'::jsonb), v_row->>'invalidation_reason',
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()), coalesce(nullif(v_row->>'updated_at', '')::timestamptz, now()));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'swing_trades', '[]'::jsonb)) loop
        insert into public.swing_trades(id, user_id, candidate_id, symbol, company_name, sector, trade_mode, status,
            signal_entry, maximum_entry, entry_date, entry_price, quantity, initial_stop, current_stop,
            initial_risk_per_share, planned_risk_inr, current_price, current_price_as_of, highest_close,
            unrealized_pnl_inr, unrealized_r_multiple, exit_signal_reason, exit_signal_at, exit_date, exit_price,
            fees_inr, realized_pnl_inr, realized_r_multiple, notes, created_at, updated_at)
        values ((v_row->>'id')::uuid, v_user_id, nullif(v_row->>'candidate_id', '')::uuid, v_row->>'symbol',
            v_row->>'company_name', v_row->>'sector', v_row->>'trade_mode', v_row->>'status',
            (v_row->>'signal_entry')::numeric, (v_row->>'maximum_entry')::numeric, (v_row->>'entry_date')::date,
            (v_row->>'entry_price')::numeric, (v_row->>'quantity')::integer, (v_row->>'initial_stop')::numeric,
            (v_row->>'current_stop')::numeric, (v_row->>'initial_risk_per_share')::numeric,
            (v_row->>'planned_risk_inr')::numeric, nullif(v_row->>'current_price', '')::numeric,
            nullif(v_row->>'current_price_as_of', '')::date, nullif(v_row->>'highest_close', '')::numeric,
            nullif(v_row->>'unrealized_pnl_inr', '')::numeric, nullif(v_row->>'unrealized_r_multiple', '')::numeric,
            v_row->>'exit_signal_reason', nullif(v_row->>'exit_signal_at', '')::timestamptz,
            nullif(v_row->>'exit_date', '')::date, nullif(v_row->>'exit_price', '')::numeric,
            coalesce((v_row->>'fees_inr')::numeric, 0), nullif(v_row->>'realized_pnl_inr', '')::numeric,
            nullif(v_row->>'realized_r_multiple', '')::numeric, v_row->>'notes',
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()), coalesce(nullif(v_row->>'updated_at', '')::timestamptz, now()));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'swing_trade_events', '[]'::jsonb)) loop
        insert into public.swing_trade_events(id, user_id, trade_id, event_type, event_at, price, stop_price, reason, metadata, created_at)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'trade_id')::uuid, v_row->>'event_type',
            (v_row->>'event_at')::timestamptz, nullif(v_row->>'price', '')::numeric,
            nullif(v_row->>'stop_price', '')::numeric, v_row->>'reason', coalesce(v_row->'metadata', '{}'::jsonb),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()));
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v2(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.restore_complete_portfolio_backup(p_backup);
    perform public.restore_swing_lab_backup(p_backup);
end;
$$;

revoke all on function public.ingest_swing_lab_scan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_swing_lab_scan(uuid, jsonb) to service_role;

grant select, insert, update, delete on public.swing_lab_settings to authenticated;
grant select, insert, update, delete on public.swing_scan_runs to authenticated;
grant select, insert, update, delete on public.swing_candidates to authenticated;
grant select, insert, update, delete on public.swing_trades to authenticated;
grant select, insert, update, delete on public.swing_trade_events to authenticated;

grant execute on function public.save_swing_lab_settings(numeric, numeric, integer, integer, numeric, boolean) to authenticated;
grant execute on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) to authenticated;
grant execute on function public.skip_swing_candidate(uuid, text) to authenticated;
grant execute on function public.update_swing_trade_stop(uuid, numeric, text) to authenticated;
grant execute on function public.confirm_swing_exit(uuid, date, numeric, numeric, text) to authenticated;
grant execute on function public.restore_swing_lab_backup(jsonb) to authenticated;
grant execute on function public.restore_complete_portfolio_backup_v2(jsonb) to authenticated;

commit;
