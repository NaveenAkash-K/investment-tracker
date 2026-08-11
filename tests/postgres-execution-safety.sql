\set ON_ERROR_STOP on

-- This suite is intentionally rolled back: it exercises broker-state behavior
-- without leaving fixtures in the CI database.
begin;

insert into auth.users(id) values ('22222222-2222-2222-2222-222222222222');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

insert into public.swing_lab_settings(user_id, trading_capital_inr, risk_per_trade_percentage,
    max_open_positions, max_sector_positions, minimum_setup_score, paper_mode)
values ('22222222-2222-2222-2222-222222222222', 10000, 0.5, 2, 1, 70, true);
insert into public.swing_automation_controls(user_id)
values ('22222222-2222-2222-2222-222222222222') on conflict do nothing;
update public.swing_automation_controls set
    live_max_deployed_inr = 5000,
    live_risk_per_trade_percentage = 0.5,
    live_daily_loss_limit_inr = 100
where user_id = '22222222-2222-2222-2222-222222222222';

insert into public.swing_scan_runs(
    id,user_id,as_of,status,model_version,market_regime,universe_size,eligible_size
) values (
    '22222222-2222-2222-2222-222222222201','22222222-2222-2222-2222-222222222222',
    now(),'successful','test','GREEN',1,1
);
insert into public.swing_candidates(
    id,user_id,scan_id,signal_key,symbol,company_name,sector,status,setup_score,
    setup_as_of,expires_on,market_regime,close_price,entry_trigger,maximum_entry,
    initial_stop,atr,risk_per_share,suggested_quantity,suggested_risk_inr
) values (
    '22222222-2222-2222-2222-222222222202','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222201','TEST:2026-08-11','TEST','Test Ltd','Test',
    'ready',85,current_date,current_date+5,'GREEN',495,500,500,490,5,10,10,100
);

-- OAuth must never silently replace the pinned Kite account.
insert into public.kite_broker_connections(user_id,broker_user_id,connection_status)
values ('22222222-2222-2222-2222-222222222222','BROKER-A','connected');
do $$
declare rejected boolean := false;
begin
    begin
        update public.kite_broker_connections set broker_user_id = 'BROKER-B'
        where user_id = '22222222-2222-2222-2222-222222222222';
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Broker identity replacement was accepted.'; end if;
end;
$$;
do $$
declare rejected boolean := false;
begin
    begin
        update public.kite_broker_connections set pinned_broker_user_id = 'BROKER-B'
        where user_id = '22222222-2222-2222-2222-222222222222';
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Direct broker identity pin replacement was accepted.'; end if;
end;
$$;

-- An entry is sized against maximum_entry and its stop, not the observed quote.
insert into public.swing_order_intents(
    user_id,candidate_id,intent_key,intent_purpose,automation_mode,status,
    strategy_model_version,execution_policy_version,nse_session,symbol,
    transaction_type,order_type,quantity,limit_price,maximum_entry,approval_status,metadata
) values (
    '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222202',
    'max-fill-sizing','entry','assisted_live','pending','test','test',current_date,
    'TEST','BUY','LIMIT',10,500,500,'approved','{"initial_stop":490}'::jsonb
);
do $$
declare actual integer;
begin
    select quantity into actual from public.swing_order_intents
    where user_id='22222222-2222-2222-2222-222222222222' and intent_key='max-fill-sizing';
    if actual <> 2 then raise exception 'Maximum-fill sizing expected 2 shares, got %.', actual; end if;
end;
$$;

-- Claim-time validation must reject a stale or absent reconciliation.
do $$
declare rejected boolean := false;
begin
    begin
        update public.swing_order_intents set status='leased'
        where user_id='22222222-2222-2222-2222-222222222222' and intent_key='max-fill-sizing';
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Entry claim without fresh reconciliation was accepted.'; end if;
end;
$$;

insert into public.swing_broker_account_snapshots(
    user_id,worker_id,observed_at,broker_user_id,account_status,available_cash
) values (
    '22222222-2222-2222-2222-222222222222','behavior-test',now(),'BROKER-A','healthy',10000
);
insert into public.swing_reconciliation_runs(
    user_id,worker_id,reconciliation_status,tracker_positions,broker_positions,
    matched_positions,mismatch_positions,broker_only_positions,checked_at
) values (
    '22222222-2222-2222-2222-222222222222','behavior-test','matched',0,0,0,0,0,now()
);

-- The same entry can be leased only after both fresh facts exist.
update public.swing_order_intents set status='leased'
where user_id='22222222-2222-2222-2222-222222222222' and intent_key='max-fill-sizing';
do $$
declare actual text;
begin
    select status into actual from public.swing_order_intents
    where user_id='22222222-2222-2222-2222-222222222222' and intent_key='max-fill-sizing';
    if actual <> 'leased' then raise exception 'Fresh entry claim did not lease.'; end if;
end;
$$;

-- A ready setup is research only; manual execution requires monitor evidence.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare rejected boolean := false;
begin
    begin
        perform public.confirm_swing_entry(
            '22222222-2222-2222-2222-222222222202',current_date,500,1,'paper','guard test'
        );
    exception when others then rejected := true;
    end;
    if not rejected then raise exception 'Manual entry before a monitored trigger was accepted.'; end if;
end;
$$;
reset role;

-- Partial and final live fills use one fill-level, charge-inclusive ledger.
insert into public.swing_trades(
    id,user_id,candidate_id,symbol,company_name,sector,trade_mode,execution_source,status,
    signal_entry,maximum_entry,entry_date,entry_price,quantity,initial_stop,current_stop,
    initial_risk_per_share,planned_risk_inr
) values (
    '22222222-2222-2222-2222-222222222205','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222202','TEST','Test Ltd','Test','live','assisted_live','open',
    500,500,current_date,500,2,490,490,10,20
);
update public.swing_order_intents set
    trade_id='22222222-2222-2222-2222-222222222205',status='filled'
where user_id='22222222-2222-2222-2222-222222222222' and intent_key='max-fill-sizing';
insert into public.swing_broker_orders(
    id,user_id,intent_id,broker_order_id,status,quantity,filled_quantity,pending_quantity,
    average_price,charges_total_inr,charges_status
) select
    '22222222-2222-2222-2222-222222222206',user_id,id,'ENTRY-1','COMPLETE',2,2,0,
    500,10,'broker_calculated'
from public.swing_order_intents where intent_key='max-fill-sizing';
insert into public.swing_broker_fills(
    id,user_id,order_id,broker_trade_id,quantity,price,filled_at
) values (
    '22222222-2222-2222-2222-222222222207','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222206','ENTRY-FILL-1',2,500,now()
);
insert into public.swing_order_intents(
    id,user_id,trade_id,intent_key,intent_purpose,automation_mode,status,
    strategy_model_version,execution_policy_version,nse_session,symbol,
    transaction_type,order_type,quantity,limit_price,approval_status
) values (
    '22222222-2222-2222-2222-222222222208','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222205','partial-exit','exit','assisted_live','filled',
    'test','test',current_date,'TEST','SELL','LIMIT',1,480,'approved'
);
insert into public.swing_broker_orders(
    id,user_id,intent_id,broker_order_id,status,quantity,filled_quantity,pending_quantity,
    average_price,charges_total_inr,charges_status
) values (
    '22222222-2222-2222-2222-222222222209','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222208','EXIT-1','COMPLETE',1,1,0,480,5,'broker_calculated'
);
insert into public.swing_broker_fills(
    id,user_id,order_id,broker_trade_id,quantity,price,filled_at
) values (
    '22222222-2222-2222-2222-222222222210','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222209','EXIT-FILL-1',1,480,now()
);
set role service_role;
select public.refresh_swing_trade_execution_accounting(
    '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222205'
);
reset role;
do $$
declare open_qty integer; net numeric; daily numeric;
begin
    select open_quantity,net_realized_pnl_inr into open_qty,net from public.swing_trades
    where id='22222222-2222-2222-2222-222222222205';
    daily := public.swing_daily_net_realized('22222222-2222-2222-2222-222222222222',current_date);
    if open_qty <> 1 or net <> -30 or daily <> -30 then
        raise exception 'Partial accounting mismatch: open %, net %, daily %.',open_qty,net,daily;
    end if;
end;
$$;

-- Active entry locks must not prevent a fresh, matched reduce-only exit.
update public.swing_automation_controls set
    automation_mode='assisted_live',broker_execution_enabled=true,new_entries_enabled=false
where user_id='22222222-2222-2222-2222-222222222222';
insert into public.swing_position_reconciliations(
    user_id,trade_id,symbol,reconciliation_status,tracker_quantity,broker_quantity,
    tracker_average_price,broker_average_price,checked_at
) values (
    '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222205',
    'TEST','matched',1,1,500,500,now()
);
insert into public.swing_risk_control_activations(user_id,control_type,status,reason)
values ('22222222-2222-2222-2222-222222222222','funds','active','behavior test entry lock');
insert into public.swing_order_intents(
    id,user_id,trade_id,intent_key,intent_purpose,automation_mode,status,
    strategy_model_version,execution_policy_version,nse_session,symbol,
    transaction_type,order_type,quantity,limit_price,approval_status
) values (
    '22222222-2222-2222-2222-222222222214','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222205','reduce-only-exit','exit','assisted_live','pending',
    'test','test',current_date,'TEST','SELL','LIMIT',1,480,'approved'
);
set role service_role;
do $$
declare claimed jsonb;
begin
    claimed := public.claim_swing_reduce_only_exit(
        '22222222-2222-2222-2222-222222222222','behavior-worker','assisted_live',30
    );
    if claimed is null or claimed->>'status' <> 'leased' or not coalesce((claimed->>'reduce_only')::boolean,false) then
        raise exception 'Reduce-only exit was not claimable under an entry risk lock.';
    end if;
end;
$$;
reset role;

insert into public.swing_order_intents(
    id,user_id,trade_id,intent_key,intent_purpose,automation_mode,status,
    strategy_model_version,execution_policy_version,nse_session,symbol,
    transaction_type,order_type,quantity,limit_price,approval_status
) values (
    '22222222-2222-2222-2222-222222222211','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222205','final-exit','exit','assisted_live','filled',
    'test','test',current_date,'TEST','SELL','LIMIT',1,510,'approved'
);
insert into public.swing_broker_orders(
    id,user_id,intent_id,broker_order_id,status,quantity,filled_quantity,pending_quantity,
    average_price,charges_total_inr,charges_status
) values (
    '22222222-2222-2222-2222-222222222212','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222211','EXIT-2','COMPLETE',1,1,0,510,3,'broker_calculated'
);
insert into public.swing_broker_fills(
    id,user_id,order_id,broker_trade_id,quantity,price,filled_at
) values (
    '22222222-2222-2222-2222-222222222213','22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222212','EXIT-FILL-2',1,510,now()
);
set role service_role;
select public.refresh_swing_trade_execution_accounting(
    '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222205'
);
reset role;
do $$
declare trade_status text; qty integer; open_qty integer; gross numeric; charges numeric; net numeric;
begin
    select status,quantity,open_quantity,gross_realized_pnl_inr,broker_charges_inr,net_realized_pnl_inr
    into trade_status,qty,open_qty,gross,charges,net from public.swing_trades
    where id='22222222-2222-2222-2222-222222222205';
    if trade_status <> 'closed' or qty <> 2 or open_qty <> 0
       or gross <> -10 or charges <> 18 or net <> -28 then
        raise exception 'Final accounting mismatch: status %, qty %, open %, gross %, charges %, net %.',
            trade_status,qty,open_qty,gross,charges,net;
    end if;
end;
$$;

-- News delivery claims are atomic and cannot be claimed twice.
insert into public.market_event_alerts(user_id,alert_key,alert_type,status,reason)
values ('22222222-2222-2222-2222-222222222222','digest:test','daily_digest','pending','test');
set role service_role;
do $$
declare first_claim text[]; second_claim text[];
begin
    first_claim := public.claim_news_alert_delivery(
        '22222222-2222-2222-2222-222222222222',array['digest:test'],
        '22222222-2222-2222-2222-222222222203'
    );
    second_claim := public.claim_news_alert_delivery(
        '22222222-2222-2222-2222-222222222222',array['digest:test'],
        '22222222-2222-2222-2222-222222222204'
    );
    if cardinality(first_claim) <> 1 or cardinality(second_claim) <> 0 then
        raise exception 'News delivery claim is not idempotent.';
    end if;
end;
$$;
reset role;

rollback;
select 'POSTGRES_EXECUTION_SAFETY_OK' as result;
