\set ON_ERROR_STOP on

begin;

insert into auth.users(id) values ('33333333-3333-3333-3333-333333333333');
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
insert into public.swing_lab_settings(user_id,trading_capital_inr,risk_per_trade_percentage,
    max_open_positions,max_sector_positions,minimum_setup_score,paper_mode)
values ('33333333-3333-3333-3333-333333333333',10000,0.5,2,1,70,true);
insert into public.swing_automation_controls(user_id)
values ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
update public.swing_automation_controls set
    live_max_open_positions=2,live_max_new_entries_per_day=1,
    live_max_deployed_inr=5000,live_risk_per_trade_percentage=0.5
where user_id='33333333-3333-3333-3333-333333333333';

insert into public.swing_scan_runs(id,user_id,as_of,status,model_version,market_regime,universe_size,eligible_size)
values ('33333333-3333-3333-3333-333333333301','33333333-3333-3333-3333-333333333333',now(),'successful','test','GREEN',1,1);
insert into public.swing_candidates(
    id,user_id,scan_id,signal_key,symbol,company_name,sector,status,setup_score,
    setup_as_of,expires_on,market_regime,close_price,entry_trigger,maximum_entry,
    initial_stop,atr,risk_per_share,suggested_quantity,suggested_risk_inr
) values (
    '33333333-3333-3333-3333-333333333302','33333333-3333-3333-3333-333333333333',
    '33333333-3333-3333-3333-333333333301','CLAIM:TEST','CLAIM','Claim Test','IT','ready',85,
    current_date,current_date+5,'GREEN',490,500,500,490,5,10,2,20
);
insert into public.swing_order_intents(
    id,user_id,candidate_id,intent_key,intent_purpose,automation_mode,status,
    strategy_model_version,execution_policy_version,nse_session,symbol,
    transaction_type,order_type,quantity,limit_price,maximum_entry,approval_status
) values (
    '33333333-3333-3333-3333-333333333303','33333333-3333-3333-3333-333333333333',
    '33333333-3333-3333-3333-333333333302','claim-residual','entry','gtt_assisted','pending',
    'test','test',current_date,'CLAIM','BUY','LIMIT',2,500,500,'approved'
);
insert into public.swing_reconciliation_runs(
    user_id,worker_id,reconciliation_status,tracker_positions,broker_positions,
    matched_positions,mismatch_positions,broker_only_positions,checked_at
) values ('33333333-3333-3333-3333-333333333333','test','matched',0,0,0,0,0,now());
insert into public.swing_broker_account_snapshots(
    user_id,worker_id,observed_at,account_status,available_cash
) values ('33333333-3333-3333-3333-333333333333','test',now(),'healthy',900);

do $$
declare rejected boolean := false;
begin
    begin
        update public.swing_order_intents set status='leased'
        where id='33333333-3333-3333-3333-333333333303';
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Claim ignored the reduced broker cash snapshot.'; end if;
end;
$$;
update public.swing_broker_account_snapshots set available_cash=5000
where user_id='33333333-3333-3333-3333-333333333333';
update public.swing_order_intents set status='leased'
where id='33333333-3333-3333-3333-333333333303';

-- A watchlist failure must roll back the scan inserted by the first RPC.
set role service_role;
do $$
declare rejected boolean := false;
begin
    begin
        perform public.ingest_swing_lab_scan_with_watchlist(
            '33333333-3333-3333-3333-333333333333',
            '{"contract_version":"2026-07-30.v2","scan_id":"33333333-3333-3333-3333-333333333310","as_of":"2026-08-11T17:30:00+05:30","status":"successful","model_version":"test","market_regime":"GREEN","session_state":"completed","session_matches_expected":true,"candidates":[],"technical_setups":[{"signal_key":"BAD","symbol":"BAD","company_name":"Bad","setup_score":101,"setup_as_of":"2026-08-11","expires_on":"2026-08-15","market_regime":"GREEN","close_price":100,"entry_trigger":101,"maximum_entry":102,"initial_stop":95}]}'::jsonb
        );
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Invalid watchlist row did not reject the atomic publication.'; end if;
    if exists (select 1 from public.swing_scan_runs where id='33333333-3333-3333-3333-333333333310') then
        raise exception 'Failed watchlist publication left a partial scan.';
    end if;
end;
$$;

insert into public.market_event_alerts(
    id,user_id,alert_key,alert_type,status,reason,delivery_claimed_at,delivery_claim_token
) values (
    '33333333-3333-3333-3333-333333333320','33333333-3333-3333-3333-333333333333',
    'digest:uncertain','daily_digest','sending','test',now()-interval '31 minutes',
    '33333333-3333-3333-3333-333333333321'
);
select public.mark_stale_news_delivery_claims('33333333-3333-3333-3333-333333333333');
reset role;
do $$ begin
    if not exists (select 1 from public.market_event_alerts
        where id='33333333-3333-3333-3333-333333333320' and status='uncertain') then
        raise exception 'Stale sending delivery did not become uncertain.';
    end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.resolve_news_alert_delivery(
    '33333333-3333-3333-3333-333333333320','retry'
);
reset role;
do $$ begin
    if not exists (select 1 from public.market_event_alerts
        where id='33333333-3333-3333-3333-333333333320' and status='failed') then
        raise exception 'Owner-authorized news retry was not recorded.';
    end if;
end $$;

rollback;
select 'POSTGRES_REREVIEW_RESIDUAL_OK' as result;
