begin;

-- RRR-03: serialize every live entry claim through the user's controls row and
-- re-check all mutable portfolio/funds limits at the instant of leasing.
create or replace function public.enforce_swing_entry_claim_safety()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_reason text;
    v_controls public.swing_automation_controls%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_available_cash numeric;
    v_open_count integer;
    v_sector_count integer;
    v_sector_limit integer := 1;
    v_daily_entries integer;
    v_deployed numeric;
    v_required numeric;
begin
    if new.intent_purpose <> 'entry'
       or new.automation_mode not in ('gtt_assisted','assisted_live','live_auto')
       or new.status <> 'leased' or old.status = 'leased' then
        return new;
    end if;

    select * into v_controls from public.swing_automation_controls
    where user_id = new.user_id for update;
    select * into v_candidate from public.swing_candidates
    where id = new.candidate_id and user_id = new.user_id;
    if not found or v_controls.user_id is null then
        raise exception 'Candidate and execution controls are required when an entry is claimed.';
    end if;
    if exists (select 1 from public.swing_risk_control_activations
               where user_id = new.user_id and status = 'active') then
        raise exception 'An active execution risk lock blocks new entries.';
    end if;
    if not exists (select 1 from public.swing_reconciliation_runs
                   where user_id = new.user_id and reconciliation_status = 'matched'
                     and checked_at > now() - interval '10 minutes') then
        raise exception 'Fresh matched reconciliation is required when an entry is claimed.';
    end if;
    select available_cash into v_available_cash
    from public.swing_broker_account_snapshots
    where user_id = new.user_id and account_status = 'healthy'
      and observed_at > now() - interval '10 minutes'
    order by observed_at desc limit 1;
    if v_available_cash is null then
        raise exception 'A fresh healthy broker account snapshot is required when an entry is claimed.';
    end if;

    select count(*), coalesce(sum(coalesce(entry_price,0) * coalesce(open_quantity,quantity)),0)
    into v_open_count, v_deployed
    from public.swing_trades
    where user_id = new.user_id and trade_mode = 'live'
      and status in ('open','exit_pending');
    select coalesce(max_sector_positions,1) into v_sector_limit
    from public.swing_lab_settings where user_id = new.user_id;
    v_sector_limit := least(greatest(coalesce(v_sector_limit,1),1),1);
    select count(*) into v_sector_count
    from public.swing_trades
    where user_id = new.user_id and trade_mode = 'live'
      and status in ('open','exit_pending')
      and coalesce(sector,'Unclassified') = coalesce(v_candidate.sector,'Unclassified');
    select count(*) into v_daily_entries
    from public.swing_order_intents
    where user_id = new.user_id and id <> new.id and intent_purpose = 'entry'
      and automation_mode in ('gtt_assisted','assisted_live','live_auto')
      and nse_session = new.nse_session
      and status not in ('cancelled','rejected','blocked','failed');

    v_required := greatest(coalesce(new.maximum_entry,new.limit_price,0),0) * new.quantity;
    if v_open_count >= v_controls.live_max_open_positions then
        raise exception 'The maximum live-position count was reached before this entry claim.';
    end if;
    if v_sector_count >= v_sector_limit then
        raise exception 'The live same-sector limit was reached before this entry claim.';
    end if;
    if v_daily_entries >= v_controls.live_max_new_entries_per_day then
        raise exception 'The daily live-entry limit was reached before this entry claim.';
    end if;
    if v_required <= 0 or v_deployed + v_required > v_controls.live_max_deployed_inr + 0.01 then
        raise exception 'The deployment cap was exceeded before this entry claim.';
    end if;
    if v_required > v_available_cash + 0.01 then
        raise exception 'Available broker cash became insufficient before this entry claim.';
    end if;
    v_reason := public.swing_entry_loss_gate_reason(new.user_id, new.nse_session);
    if v_reason is not null then raise exception '%', v_reason; end if;
    return new;
end;
$$;

-- RRR-06/RRR-07: publish the scan, its technical research rows and prior
-- shadow outcomes in one transaction. A failed watchlist write rolls back the
-- scan publication instead of presenting a false empty watchlist.
alter table public.swing_setup_watchlist
    add column if not exists outcome_at timestamptz,
    add column if not exists outcome_reason text,
    add column if not exists last_price numeric,
    add column if not exists last_price_as_of date;

create or replace function public.ingest_swing_lab_scan_with_watchlist(
    p_user_id uuid,
    p_scan jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row jsonb;
    v_status text;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    perform public.ingest_swing_lab_scan(p_user_id, p_scan);
    perform public.ingest_swing_setup_watchlist(
        p_user_id,
        (p_scan->>'scan_id')::uuid,
        coalesce(p_scan->'technical_setups','[]'::jsonb)
    );
    for v_row in select value from jsonb_array_elements(coalesce(p_scan->'watchlist_updates','[]'::jsonb)) loop
        v_status := nullif(v_row->>'outcome_status','');
        if v_status not in ('triggered','expired','invalidated','missed') then
            raise exception 'Invalid Swing watchlist outcome status.';
        end if;
        update public.swing_setup_watchlist set
            outcome_status = case
                when outcome_status = 'unobserved' then v_status
                when outcome_status = 'triggered' and v_status = 'missed' then 'missed'
                else outcome_status
            end,
            outcome_at = case
                when outcome_status = 'unobserved'
                  or (outcome_status = 'triggered' and v_status = 'missed')
                then now() else outcome_at end,
            outcome_reason = coalesce(nullif(left(v_row->>'reason',500),''), outcome_reason),
            last_price = coalesce(nullif(v_row->>'last_price','')::numeric,last_price),
            last_price_as_of = coalesce(nullif(v_row->>'last_price_as_of','')::date,last_price_as_of)
        where id = nullif(v_row->>'id','')::uuid and user_id = p_user_id;
    end loop;
end;
$$;

revoke all on function public.ingest_swing_lab_scan_with_watchlist(uuid,jsonb)
    from public,anon,authenticated;
grant execute on function public.ingest_swing_lab_scan_with_watchlist(uuid,jsonb)
    to service_role;

-- RRR-08: execution_source='manual' is meaningful and therefore cannot use a
-- null fallback. Split it explicitly by the trade's paper/live mode.
create or replace function public.get_swing_performance_scorecards()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with grouped as (
        select
            case when t.execution_source = 'manual'
                then case when t.trade_mode = 'paper' then 'manual_paper' else 'manual_live' end
                else t.execution_source end as source,
            count(*) filter (where t.status = 'closed') as closed_trades,
            count(*) filter (where t.status in ('open','exit_pending')) as open_trades,
            coalesce(sum(coalesce(t.net_realized_pnl_inr,t.realized_pnl_inr,0))
                filter (where t.status = 'closed'),0) as net_pnl,
            avg(t.realized_r_multiple)
                filter (where t.status = 'closed' and t.realized_r_multiple is not null) as expectancy_r,
            count(*) filter (where t.status = 'closed'
                and coalesce(t.net_realized_pnl_inr,t.realized_pnl_inr,0) > 0) as winning_trades
        from public.swing_trades t
        where t.user_id = auth.uid()
        group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'source', source, 'closed_trades', closed_trades, 'open_trades', open_trades,
        'net_pnl_inr', round(net_pnl,2), 'expectancy_r', round(expectancy_r,3),
        'win_rate_percentage', case when closed_trades > 0
            then round(winning_trades * 100.0 / closed_trades,1) else null end
    ) order by source), '[]'::jsonb) from grouped;
$$;

-- RRR-11: a realization is fully broker-calculated only when both its entry
-- and exit charges are available. Mixed availability is explicitly partial.
alter table public.swing_trade_realizations
    drop constraint if exists swing_trade_realizations_charges_status_check;
alter table public.swing_trade_realizations
    add constraint swing_trade_realizations_charges_status_check
    check (charges_status in ('unavailable','partial','broker_calculated','estimated'));

create or replace function public.refresh_swing_trade_execution_accounting(
    p_user_id uuid,
    p_trade_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_trade public.swing_trades%rowtype;
    v_original integer := 0;
    v_closed integer := 0;
    v_entry_charges numeric := 0;
    v_entry_charges_status text := 'unavailable';
    v_gross numeric := 0;
    v_charges numeric := 0;
    v_net numeric := 0;
    v_exit_price numeric := null;
    v_exit_date date := null;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select * into v_trade from public.swing_trades
    where id = p_trade_id and user_id = p_user_id for update;
    if not found or v_trade.execution_source not in ('gtt_assisted','assisted_live','live_auto') then return; end if;

    select coalesce(sum(f.quantity),0) into v_original
    from public.swing_broker_fills f
    join public.swing_broker_orders o on o.id = f.order_id and o.user_id = f.user_id
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where f.user_id = p_user_id and i.trade_id = p_trade_id and i.intent_purpose = 'entry';

    select coalesce(sum(o.charges_total_inr),0),
           case
             when count(*) = 0 then 'unavailable'
             when bool_and(o.charges_status = 'broker_calculated') then 'broker_calculated'
             when bool_and(o.charges_status = 'estimated') then 'estimated'
             when bool_or(o.charges_status in ('broker_calculated','estimated')) then 'partial'
             else 'unavailable'
           end
    into v_entry_charges, v_entry_charges_status
    from public.swing_broker_orders o
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where o.user_id = p_user_id and i.trade_id = p_trade_id
      and i.intent_purpose = 'entry' and o.filled_quantity > 0;

    if v_original <= 0 then return; end if;

    insert into public.swing_trade_realizations(
        user_id, trade_id, broker_fill_id, execution_source, realized_on,
        quantity, entry_price, exit_price, gross_pnl_inr,
        entry_charges_allocated_inr, exit_charges_allocated_inr,
        net_pnl_inr, charges_status
    )
    select
        p_user_id, p_trade_id, f.id, v_trade.execution_source,
        (f.filled_at at time zone 'Asia/Kolkata')::date,
        f.quantity, v_trade.entry_price, f.price,
        (f.price - v_trade.entry_price) * f.quantity,
        v_entry_charges * f.quantity / greatest(v_original,1),
        o.charges_total_inr * f.quantity / greatest(o.filled_quantity,1),
        (f.price - v_trade.entry_price) * f.quantity
          - v_entry_charges * f.quantity / greatest(v_original,1)
          - o.charges_total_inr * f.quantity / greatest(o.filled_quantity,1),
        case
          when v_entry_charges_status = 'broker_calculated' and o.charges_status = 'broker_calculated'
            then 'broker_calculated'
          when v_entry_charges_status = 'estimated' and o.charges_status = 'estimated'
            then 'estimated'
          when v_entry_charges_status = 'unavailable' and o.charges_status = 'unavailable'
            then 'unavailable'
          else 'partial'
        end
    from public.swing_broker_fills f
    join public.swing_broker_orders o on o.id = f.order_id and o.user_id = f.user_id
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where f.user_id = p_user_id and i.trade_id = p_trade_id
      and i.intent_purpose in ('exit','protective_stop')
    on conflict(user_id, broker_fill_id) do update set
        quantity = excluded.quantity,
        entry_price = excluded.entry_price,
        exit_price = excluded.exit_price,
        gross_pnl_inr = excluded.gross_pnl_inr,
        entry_charges_allocated_inr = excluded.entry_charges_allocated_inr,
        exit_charges_allocated_inr = excluded.exit_charges_allocated_inr,
        net_pnl_inr = excluded.net_pnl_inr,
        charges_status = excluded.charges_status;

    select coalesce(sum(quantity),0), coalesce(sum(gross_pnl_inr),0),
           coalesce(sum(entry_charges_allocated_inr + exit_charges_allocated_inr),0),
           coalesce(sum(net_pnl_inr),0),
           sum(exit_price * quantity) / nullif(sum(quantity),0), max(realized_on)
    into v_closed,v_gross,v_charges,v_net,v_exit_price,v_exit_date
    from public.swing_trade_realizations
    where user_id = p_user_id and trade_id = p_trade_id;

    update public.swing_trades set
        original_quantity = v_original,
        open_quantity = greatest(v_original-v_closed,0),
        status = case when v_closed >= v_original then 'closed' else status end,
        quantity = case when v_closed >= v_original then v_original else greatest(v_original-v_closed,0) end,
        planned_risk_inr = initial_risk_per_share * case when v_closed >= v_original
            then v_original else greatest(v_original-v_closed,0) end,
        gross_realized_pnl_inr = v_gross, broker_charges_inr = v_charges,
        net_realized_pnl_inr = v_net, fees_inr = v_charges,
        partial_exit_quantity = least(v_closed,v_original),
        partial_exit_realized_pnl_inr = case when v_closed < v_original then v_net else 0 end,
        exit_date = case when v_closed >= v_original then v_exit_date else exit_date end,
        exit_price = case when v_closed >= v_original then v_exit_price else exit_price end,
        unrealized_pnl_inr = case when v_closed >= v_original then null else unrealized_pnl_inr end,
        unrealized_r_multiple = case when v_closed >= v_original then null else unrealized_r_multiple end,
        realized_pnl_inr = case when v_closed >= v_original then v_net else null end,
        realized_r_multiple = case when v_closed >= v_original
            then v_net/greatest(initial_risk_per_share*v_original,0.01) else null end
    where id = p_trade_id and user_id = p_user_id;
end;
$$;

-- RRR-10: an interrupted SMTP request becomes an explicit uncertain outcome.
-- It is never retried automatically; the owner must mark it sent, retryable or
-- suppressed from Operations.
alter table public.market_event_alerts
    drop constraint if exists market_event_alerts_status_check;
alter table public.market_event_alerts
    add constraint market_event_alerts_status_check
    check (status in ('pending','sending','uncertain','sent','failed','suppressed'));

create or replace function public.mark_stale_news_delivery_claims(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    update public.market_event_alerts set
        status = 'uncertain',
        delivery_error = 'Delivery acknowledgement was not recorded. Verify the mailbox before choosing retry.',
        delivery_claim_token = null
    where user_id = p_user_id and status = 'sending'
      and delivery_claimed_at <= now() - interval '30 minutes';
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

create or replace function public.resolve_news_alert_delivery(
    p_alert_id uuid,
    p_resolution text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_resolution not in ('sent','retry','suppressed') then
        raise exception 'Invalid news-delivery resolution.';
    end if;
    update public.market_event_alerts set
        status = case when p_resolution = 'retry' then 'failed' else p_resolution end,
        delivered_at = case when p_resolution = 'sent' then coalesce(delivered_at,now()) else delivered_at end,
        delivery_error = case
            when p_resolution = 'retry' then 'Owner verified that retry is safe.'
            when p_resolution = 'sent' then 'Owner verified delivery after an uncertain acknowledgement.'
            else 'Owner suppressed an uncertain delivery.' end,
        delivery_claim_token = null,
        delivery_claimed_at = null
    where id = p_alert_id and user_id = v_user_id
      and (status = 'uncertain'
        or (status = 'sending' and delivery_claimed_at <= now() - interval '30 minutes'));
    if not found then raise exception 'Uncertain news delivery was not found.'; end if;
end;
$$;

do $$
begin
    if to_regprocedure('public.ingest_news_event_run_residual_v1(uuid,jsonb)') is null
       and to_regprocedure('public.ingest_news_event_run(uuid,jsonb)') is not null then
        execute 'alter function public.ingest_news_event_run(uuid,jsonb) rename to ingest_news_event_run_residual_v1';
    end if;
end;
$$;

create or replace function public.ingest_news_event_run(p_user_id uuid,p_run jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    perform public.mark_stale_news_delivery_claims(p_user_id);
    perform public.ingest_news_event_run_residual_v1(p_user_id,p_run);
end;
$$;

revoke all on function public.mark_stale_news_delivery_claims(uuid) from public,anon,authenticated;
grant execute on function public.mark_stale_news_delivery_claims(uuid) to service_role;
revoke all on function public.resolve_news_alert_delivery(uuid,text) from public,anon;
grant execute on function public.resolve_news_alert_delivery(uuid,text) to authenticated;
revoke all on function public.ingest_news_event_run_residual_v1(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.ingest_news_event_run(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_news_event_run(uuid,jsonb) to service_role;

-- RRR-09: backup version 6 includes research and immutable execution evidence.
-- Restore deliberately excludes sessions, leases, risk controls and protective
-- orders, and v11 disarms every live mode before this historical data is read.
create or replace function public.restore_complete_portfolio_backup_v12(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_compatible jsonb;
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer,0) not in (1,2,3,4,5,6) then
        raise exception 'Unsupported backup format or version.';
    end if;
    v_compatible := jsonb_set(p_backup,'{version}','5'::jsonb,true);
    perform public.restore_complete_portfolio_backup_v11(v_compatible);

    delete from public.swing_setup_watchlist where user_id = v_user_id;
    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_setup_watchlist','[]'::jsonb)) loop
        if exists (select 1 from public.swing_scan_runs where id=(v_row->>'scan_id')::uuid and user_id=v_user_id) then
            insert into public.swing_setup_watchlist
            select (jsonb_populate_record(null::public.swing_setup_watchlist,
                v_row || jsonb_build_object('user_id',v_user_id))).*
            on conflict (user_id,scan_id,signal_key) do nothing;
        end if;
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_order_intents','[]'::jsonb)) loop
        if v_row->>'status' in ('filled','cancelled','rejected','blocked','failed') then
            if nullif(v_row->>'candidate_id','') is not null and not exists (
                select 1 from public.swing_candidates where id=(v_row->>'candidate_id')::uuid and user_id=v_user_id
            ) then v_row := jsonb_set(v_row,'{candidate_id}','null'::jsonb,true); end if;
            if nullif(v_row->>'trade_id','') is not null and not exists (
                select 1 from public.swing_trades where id=(v_row->>'trade_id')::uuid and user_id=v_user_id
            ) then v_row := jsonb_set(v_row,'{trade_id}','null'::jsonb,true); end if;
            insert into public.swing_order_intents
            select (jsonb_populate_record(null::public.swing_order_intents,
                v_row || jsonb_build_object('user_id',v_user_id,'lease_owner',null,'lease_expires_at',null))).*
            on conflict (user_id,intent_key) do nothing;
        end if;
    end loop;
    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_broker_orders','[]'::jsonb)) loop
        if exists (select 1 from public.swing_order_intents where id=(v_row->>'intent_id')::uuid and user_id=v_user_id) then
            insert into public.swing_broker_orders
            select (jsonb_populate_record(null::public.swing_broker_orders,
                v_row || jsonb_build_object('user_id',v_user_id))).*
            on conflict (user_id,broker_order_id) do nothing;
        end if;
    end loop;
    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_broker_fills','[]'::jsonb)) loop
        if exists (select 1 from public.swing_broker_orders where id=(v_row->>'order_id')::uuid and user_id=v_user_id) then
            insert into public.swing_broker_fills
            select (jsonb_populate_record(null::public.swing_broker_fills,
                v_row || jsonb_build_object('user_id',v_user_id))).*
            on conflict (user_id,broker_trade_id) do nothing;
        end if;
    end loop;
    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_trade_realizations','[]'::jsonb)) loop
        if exists (select 1 from public.swing_trades where id=(v_row->>'trade_id')::uuid and user_id=v_user_id)
           and exists (select 1 from public.swing_broker_fills where id=(v_row->>'broker_fill_id')::uuid and user_id=v_user_id) then
            insert into public.swing_trade_realizations
            select (jsonb_populate_record(null::public.swing_trade_realizations,
                v_row || jsonb_build_object('user_id',v_user_id))).*
            on conflict (user_id,broker_fill_id) do nothing;
        end if;
    end loop;
    for v_row in select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_execution_audit_events','[]'::jsonb)) loop
        insert into public.swing_execution_audit_events
        select (jsonb_populate_record(null::public.swing_execution_audit_events,
            v_row || jsonb_build_object('user_id',v_user_id))).*
        on conflict (id) do nothing;
    end loop;

    update public.swing_automation_controls set
        automation_mode='advisory',new_entries_enabled=false,armed_nse_session=null,
        assisted_live_unlocked=false,live_auto_unlocked=false,
        broker_execution_enabled=false,gtt_assisted_enabled=false
    where user_id=v_user_id;
end;
$$;

revoke all on function public.restore_complete_portfolio_backup_v12(jsonb) from public,anon;
grant execute on function public.restore_complete_portfolio_backup_v12(jsonb) to authenticated;

-- Every live mode stays disarmed after this migration.
update public.swing_automation_controls set
    automation_mode='advisory',new_entries_enabled=false,armed_nse_session=null,
    assisted_live_unlocked=false,live_auto_unlocked=false,
    broker_execution_enabled=false,gtt_assisted_enabled=false;

commit;
