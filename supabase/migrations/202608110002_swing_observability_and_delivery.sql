begin;

-- Preserve technically valid setups even when portfolio capacity, sector limits,
-- or position size make them non-actionable. These rows are research evidence;
-- only swing_candidates may drive an entry workflow.
create table if not exists public.swing_setup_watchlist (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    scan_id uuid not null references public.swing_scan_runs(id) on delete cascade,
    signal_key text not null,
    symbol text not null,
    company_name text not null,
    sector text,
    setup_type text not null default 'TREND_PULLBACK',
    setup_score numeric not null check (setup_score between 0 and 100),
    setup_as_of date not null,
    expires_on date not null,
    market_regime text not null,
    close_price numeric not null check (close_price > 0),
    entry_trigger numeric not null check (entry_trigger > 0),
    maximum_entry numeric not null check (maximum_entry >= entry_trigger),
    initial_stop numeric not null check (initial_stop > 0),
    suggested_quantity integer not null default 0 check (suggested_quantity >= 0),
    actionability_status text not null
        check (actionability_status in ('technical','actionable','capital_blocked','capacity_blocked','sector_blocked','active_candidate','position_open')),
    execution_block_reasons jsonb not null default '[]'::jsonb,
    score_components jsonb not null default '{}'::jsonb,
    reasons jsonb not null default '[]'::jsonb,
    outcome_status text not null default 'unobserved'
        check (outcome_status in ('unobserved','triggered','expired','invalidated','entered','missed')),
    created_at timestamptz not null default now(),
    unique (user_id, scan_id, signal_key)
);

create index if not exists swing_setup_watchlist_user_scan_idx
    on public.swing_setup_watchlist(user_id, scan_id, setup_score desc);
create index if not exists swing_setup_watchlist_user_symbol_idx
    on public.swing_setup_watchlist(user_id, symbol, setup_as_of desc);

alter table public.swing_setup_watchlist enable row level security;
drop policy if exists "Users view their swing setup watchlist" on public.swing_setup_watchlist;
create policy "Users view their swing setup watchlist"
    on public.swing_setup_watchlist for select using (auth.uid() = user_id);
grant select on public.swing_setup_watchlist to authenticated;
grant select, insert, update, delete on public.swing_setup_watchlist to service_role;

create or replace function public.ingest_swing_setup_watchlist(
    p_user_id uuid,
    p_scan_id uuid,
    p_setups jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row jsonb;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if not exists (select 1 from public.swing_scan_runs where id = p_scan_id and user_id = p_user_id) then
        raise exception 'The Swing scan must be published before its technical watchlist.';
    end if;
    delete from public.swing_setup_watchlist where user_id = p_user_id and scan_id = p_scan_id;
    for v_row in select value from jsonb_array_elements(coalesce(p_setups, '[]'::jsonb)) loop
        insert into public.swing_setup_watchlist(
            user_id, scan_id, signal_key, symbol, company_name, sector, setup_type,
            setup_score, setup_as_of, expires_on, market_regime, close_price,
            entry_trigger, maximum_entry, initial_stop, suggested_quantity,
            actionability_status, execution_block_reasons, score_components, reasons
        ) values (
            p_user_id, p_scan_id, v_row->>'signal_key', v_row->>'symbol',
            coalesce(nullif(v_row->>'company_name',''), v_row->>'symbol'),
            nullif(v_row->>'sector',''), coalesce(nullif(v_row->>'setup_type',''),'TREND_PULLBACK'),
            (v_row->>'setup_score')::numeric, (v_row->>'setup_as_of')::date,
            (v_row->>'expires_on')::date, coalesce(nullif(v_row->>'market_regime',''),'UNKNOWN'),
            (v_row->>'close_price')::numeric, (v_row->>'entry_trigger')::numeric,
            (v_row->>'maximum_entry')::numeric, (v_row->>'initial_stop')::numeric,
            coalesce((v_row->>'suggested_quantity')::integer,0),
            coalesce(nullif(v_row->>'actionability_status',''),'technical'),
            coalesce(v_row->'execution_block_reasons','[]'::jsonb),
            coalesce(v_row->'score_components','{}'::jsonb), coalesce(v_row->'reasons','[]'::jsonb)
        );
    end loop;
end;
$$;

alter table public.swing_candidates
    add column if not exists triggered_at timestamptz,
    add column if not exists entered_at timestamptz,
    add column if not exists expired_at timestamptz,
    add column if not exists invalidated_at timestamptz;

create or replace function public.stamp_swing_candidate_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if new.status is distinct from old.status then
        if new.status = 'triggered' then new.triggered_at := coalesce(new.triggered_at, now()); end if;
        if new.status = 'entered' then new.entered_at := coalesce(new.entered_at, now()); end if;
        if new.status = 'expired' then new.expired_at := coalesce(new.expired_at, now()); end if;
        if new.status = 'invalidated' then new.invalidated_at := coalesce(new.invalidated_at, now()); end if;
        update public.swing_setup_watchlist set outcome_status = case new.status
            when 'triggered' then 'triggered'
            when 'entered' then 'entered'
            when 'expired' then 'expired'
            when 'invalidated' then 'invalidated'
            else outcome_status end
        where user_id = new.user_id and scan_id = new.scan_id and signal_key = new.signal_key;
    end if;
    return new;
end;
$$;

create or replace function public.get_swing_candidate_lifecycle_scorecard()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with totals as (
        select
            count(*) as published,
            count(*) filter (where triggered_at is not null) as triggered,
            count(*) filter (where entered_at is not null or status = 'entered') as entered,
            count(*) filter (where expired_at is not null or status = 'expired') as expired,
            count(*) filter (where invalidated_at is not null or status = 'invalidated') as invalidated,
            percentile_cont(0.5) within group (
                order by extract(epoch from (triggered_at - created_at)) / 3600.0
            ) filter (where triggered_at is not null) as median_hours_to_trigger
        from public.swing_candidates
        where user_id = auth.uid() and created_at >= now() - interval '180 days'
          and left(setup_type, 5) <> 'TEST_'
    )
    select jsonb_build_object(
        'window_days', 180,
        'published', published,
        'triggered', triggered,
        'entered', entered,
        'expired', expired,
        'invalidated', invalidated,
        'trigger_rate_percentage', case when published > 0 then round(triggered * 100.0 / published, 1) else null end,
        'entry_rate_percentage', case when triggered > 0 then round(entered * 100.0 / triggered, 1) else null end,
        'median_hours_to_trigger', case when median_hours_to_trigger is null then null else round(median_hours_to_trigger::numeric, 1) end
    ) from totals;
$$;

drop trigger if exists swing_candidates_stamp_lifecycle on public.swing_candidates;
create trigger swing_candidates_stamp_lifecycle
before update of status on public.swing_candidates
for each row execute function public.stamp_swing_candidate_lifecycle();

create or replace function public.get_swing_performance_scorecards()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with grouped as (
        select
            coalesce(nullif(t.execution_source,''), case when t.trade_mode = 'paper' then 'manual_paper' else 'manual_live' end) as source,
            count(*) filter (where t.status = 'closed') as closed_trades,
            count(*) filter (where t.status in ('open','exit_pending')) as open_trades,
            coalesce(sum(coalesce(t.net_realized_pnl_inr,t.realized_pnl_inr,0)) filter (where t.status = 'closed'),0) as net_pnl,
            avg(t.realized_r_multiple) filter (where t.status = 'closed' and t.realized_r_multiple is not null) as expectancy_r,
            count(*) filter (where t.status = 'closed' and coalesce(t.net_realized_pnl_inr,t.realized_pnl_inr,0) > 0) as winning_trades
        from public.swing_trades t
        where t.user_id = auth.uid()
        group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'source', source, 'closed_trades', closed_trades, 'open_trades', open_trades,
        'net_pnl_inr', round(net_pnl,2), 'expectancy_r', round(expectancy_r,3),
        'win_rate_percentage', case when closed_trades > 0 then round(winning_trades * 100.0 / closed_trades,1) else null end
    ) order by source), '[]'::jsonb) from grouped;
$$;

-- Claim alert delivery before SMTP. A process crash leaves an explicit
-- uncertain "sending" row for review instead of silently sending a duplicate.
alter table public.market_event_alerts
    add column if not exists delivery_claim_token uuid,
    add column if not exists delivery_claimed_at timestamptz,
    add column if not exists delivery_attempt_count integer not null default 0;
alter table public.market_event_alerts drop constraint if exists market_event_alerts_status_check;
alter table public.market_event_alerts add constraint market_event_alerts_status_check
    check (status in ('pending','sending','sent','failed','suppressed'));

do $$
begin
    if to_regprocedure('public.ingest_news_event_run_pre_delivery_claim_v1(uuid,jsonb)') is null
       and to_regprocedure('public.ingest_news_event_run(uuid,jsonb)') is not null then
        execute 'alter function public.ingest_news_event_run(uuid,jsonb) '
             || 'rename to ingest_news_event_run_pre_delivery_claim_v1';
    end if;
end;
$$;

create or replace function public.ingest_news_event_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_sending jsonb;
    v_row jsonb;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'alert_key', alert_key, 'delivery_claim_token', delivery_claim_token,
        'delivery_claimed_at', delivery_claimed_at, 'delivery_attempt_count', delivery_attempt_count
    )), '[]'::jsonb) into v_sending
    from public.market_event_alerts
    where user_id = p_user_id and status = 'sending';

    perform public.ingest_news_event_run_pre_delivery_claim_v1(p_user_id, p_run);

    for v_row in select value from jsonb_array_elements(v_sending) loop
        update public.market_event_alerts set
            status = 'sending',
            delivery_claim_token = (v_row->>'delivery_claim_token')::uuid,
            delivery_claimed_at = (v_row->>'delivery_claimed_at')::timestamptz,
            delivery_attempt_count = (v_row->>'delivery_attempt_count')::integer
        where user_id = p_user_id and alert_key = v_row->>'alert_key' and status <> 'sent';
    end loop;
end;
$$;

create or replace function public.claim_news_alert_delivery(
    p_user_id uuid,
    p_alert_keys text[],
    p_claim_token uuid
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_keys text[];
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_claim_token is null then raise exception 'A delivery claim token is required.'; end if;
    with claimed as (
        update public.market_event_alerts
        set status = 'sending', delivery_claim_token = p_claim_token,
            delivery_claimed_at = now(), delivery_attempt_count = delivery_attempt_count + 1,
            delivery_error = null
        where user_id = p_user_id and alert_key = any(p_alert_keys) and status in ('pending','failed')
        returning alert_key
    ) select coalesce(array_agg(alert_key order by alert_key), array[]::text[]) into v_keys from claimed;
    return v_keys;
end;
$$;

create or replace function public.complete_news_alert_delivery(
    p_user_id uuid,
    p_claim_token uuid,
    p_status text,
    p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_status not in ('sent','failed','suppressed') then raise exception 'Invalid delivery completion status.'; end if;
    update public.market_event_alerts set
        status = p_status,
        delivered_at = case when p_status = 'sent' then now() else delivered_at end,
        delivery_error = nullif(p_error,''),
        delivery_claim_token = null,
        delivery_claimed_at = null
    where user_id = p_user_id and delivery_claim_token = p_claim_token and status = 'sending';
end;
$$;

revoke all on function public.ingest_swing_setup_watchlist(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_swing_setup_watchlist(uuid,uuid,jsonb) to service_role;
revoke all on function public.get_swing_performance_scorecards() from public,anon;
grant execute on function public.get_swing_performance_scorecards() to authenticated;
revoke all on function public.get_swing_candidate_lifecycle_scorecard() from public,anon;
grant execute on function public.get_swing_candidate_lifecycle_scorecard() to authenticated;
revoke all on function public.claim_news_alert_delivery(uuid,text[],uuid) from public,anon,authenticated;
grant execute on function public.claim_news_alert_delivery(uuid,text[],uuid) to service_role;
revoke all on function public.complete_news_alert_delivery(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.complete_news_alert_delivery(uuid,uuid,text,text) to service_role;
revoke all on function public.ingest_news_event_run_pre_delivery_claim_v1(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.ingest_news_event_run(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_news_event_run(uuid,jsonb) to service_role;

commit;
