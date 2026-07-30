\set ON_ERROR_STOP on

insert into auth.users(id)
values ('11111111-1111-1111-1111-111111111111');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare rejected boolean := false;
begin
    begin
        perform public.validate_analyzer_contract(
            '{"contract_version":"2026-07-30.v2","monitor_id":"20000000-0000-0000-0000-000000000001","as_of":"2026-07-30T09:25:00+05:30","status":"successful","model_version":"test","candidate_updates":[],"position_updates":[],"notifications":[]}'::jsonb,
            'swing_monitor'
        );
    exception when others then rejected := true;
    end;
    if not rejected then
        raise exception 'Missing monitor truth fields were accepted.';
    end if;
end;
$$;

do $$
declare rejected boolean := false;
begin
    begin
        perform public.validate_analyzer_contract(
            '{"contract_version":"2026-07-30.v2","monitor_id":"20000000-0000-0000-0000-000000000002","as_of":"2026-07-30T09:25:00+05:30","status":"successful","model_version":"test","candidates_requested":1,"positions_requested":0,"candidates_evaluated":0,"positions_evaluated":0,"failed_candidate_ids":[],"failed_trade_ids":[],"candidate_updates":[],"position_updates":[],"notifications":[]}'::jsonb,
            'swing_monitor'
        );
    exception when others then rejected := true;
    end;
    if not rejected then
        raise exception 'Inconsistent successful monitor was accepted.';
    end if;
end;
$$;

select public.validate_analyzer_contract(
    '{"contract_version":"2026-07-30.v2","monitor_id":"20000000-0000-0000-0000-000000000003","as_of":"2026-07-30T09:25:00+05:30","status":"partial","model_version":"test","candidates_requested":2,"positions_requested":0,"candidates_evaluated":1,"positions_evaluated":0,"failed_candidate_ids":["candidate-2"],"failed_trade_ids":[],"candidate_updates":[{}],"position_updates":[],"notifications":[]}'::jsonb,
    'swing_monitor'
) as valid_partial_contract;

select public.validate_analyzer_contract(
    '{"contract_version":"2026-07-30.v2","monitor_id":"20000000-0000-0000-0000-000000000004","as_of":"2026-07-30T09:25:00+05:30","status":"failed","model_version":"test","candidates_requested":1,"positions_requested":0,"candidates_evaluated":0,"positions_evaluated":0,"failed_candidate_ids":["candidate-1"],"failed_trade_ids":[],"candidate_updates":[],"position_updates":[],"notifications":[]}'::jsonb,
    'swing_monitor'
) as valid_failed_contract;

set role service_role;
select public.ingest_swing_lab_monitor(
    '11111111-1111-1111-1111-111111111111',
    '{"contract_version":"2026-07-30.v2","monitor_id":"20000000-0000-0000-0000-000000000005","as_of":"2026-07-30T09:25:00+05:30","status":"successful","model_version":"test","candidates_requested":0,"positions_requested":0,"candidates_evaluated":0,"positions_evaluated":0,"candidates_checked":0,"positions_checked":0,"failed_candidate_ids":[],"failed_trade_ids":[],"candidate_updates":[],"position_updates":[],"notifications":[]}'::jsonb
);
select public.ingest_swing_lab_monitor(
    '11111111-1111-1111-1111-111111111111',
    '{"contract_version":"2026-07-28.v1","monitor_id":"20000000-0000-0000-0000-000000000006","as_of":"2026-07-30T09:26:00+05:30","status":"successful","model_version":"legacy-test","candidates_checked":0,"positions_checked":0,"candidate_updates":[],"position_updates":[],"notifications":[]}'::jsonb
);
reset role;

do $$
begin
    if not exists (
        select 1
        from public.swing_monitor_runs
        where id = '20000000-0000-0000-0000-000000000005'
          and status = 'successful'
          and contract_version = '2026-07-30.v2'
    ) then
        raise exception 'Current monitor did not persist as successful.';
    end if;
    if not exists (
        select 1
        from public.swing_monitor_runs
        where id = '20000000-0000-0000-0000-000000000006'
          and status = 'partial'
          and contract_version = '2026-07-28.v1'
    ) then
        raise exception 'Legacy monitor was not downgraded to partial.';
    end if;
end;
$$;

select public.restore_complete_portfolio_backup_v7(
    jsonb_build_object(
        'format', 'investment-tracker-backup',
        'version', 4,
        'data', jsonb_build_object(
            'swing_monitor_runs', jsonb_build_array(jsonb_build_object(
                'id', '20000000-0000-0000-0000-000000000007',
                'user_id', '11111111-1111-1111-1111-111111111111',
                'as_of', '2026-07-29T09:25:00+05:30',
                'status', 'successful',
                'model_version', 'old-backup',
                'candidates_checked', 2,
                'positions_checked', 1,
                'notification_count', 0,
                'data_issues', '[]'::jsonb,
                'contract_version', '2026-07-28.v1',
                'publication_status', 'published',
                'created_at', '2026-07-29T09:25:00+05:30'
            ))
        )
    )
);

do $$
begin
    if not exists (
        select 1
        from public.swing_monitor_runs
        where id = '20000000-0000-0000-0000-000000000007'
          and status = 'partial'
          and candidates_requested = 2
          and candidates_evaluated = 2
          and positions_requested = 1
          and positions_evaluated = 1
          and failed_candidate_ids = '[]'::jsonb
          and failed_trade_ids = '[]'::jsonb
    ) then
        raise exception 'Version-4 monitor backup was not normalized and restored.';
    end if;
end;
$$;

set role service_role;
select public.claim_analyzer_notification_delivery(
    '11111111-1111-1111-1111-111111111111',
    'swing-monitor:2026-07-30:test-claim',
    'swing-monitor',
    '30000000-0000-0000-0000-000000000001'
) as first_claim;
reset role;

update public.analyzer_notification_deliveries
set claimed_at = now() - interval '20 minutes'
where delivery_key = 'swing-monitor:2026-07-30:test-claim';

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.resolve_analyzer_notification_delivery(
    (
        select id
        from public.analyzer_notification_deliveries
        where delivery_key = 'swing-monitor:2026-07-30:test-claim'
    ),
    'retry',
    'PostgreSQL recovery test'
);
reset role;

do $$
begin
    if not exists (
        select 1
        from public.analyzer_notification_deliveries
        where delivery_key = 'swing-monitor:2026-07-30:test-claim'
          and status = 'failed'
          and resolution_action = 'retry_allowed'
          and resolved_by = '11111111-1111-1111-1111-111111111111'
    ) then
        raise exception 'Retry authorization was not persisted.';
    end if;
end;
$$;

set role service_role;
select public.claim_analyzer_notification_delivery(
    '11111111-1111-1111-1111-111111111111',
    'swing-monitor:2026-07-30:test-claim',
    'swing-monitor',
    '30000000-0000-0000-0000-000000000002'
) as retry_claim;
reset role;

select public.restore_complete_portfolio_backup_v7(
    jsonb_build_object(
        'format', 'investment-tracker-backup',
        'version', 5,
        'data', jsonb_build_object(
            'swing_monitor_runs', '[]'::jsonb,
            'analyzer_notification_deliveries', jsonb_build_array(jsonb_build_object(
                'id', '40000000-0000-0000-0000-000000000001',
                'user_id', '11111111-1111-1111-1111-111111111111',
                'delivery_key', 'portfolio-daily:2026-07-29:dismissed',
                'channel', 'portfolio-daily',
                'run_id', '30000000-0000-0000-0000-000000000003',
                'status', 'dismissed',
                'attempt_count', 1,
                'claimed_at', '2026-07-29T08:00:00+05:30',
                'last_attempt_at', '2026-07-29T08:00:00+05:30',
                'resolved_at', '2026-07-29T08:30:00+05:30',
                'resolved_by', '11111111-1111-1111-1111-111111111111',
                'resolution_action', 'dismissed',
                'resolution_note', 'Verified dismissed backup restore',
                'created_at', '2026-07-29T08:00:00+05:30',
                'updated_at', '2026-07-29T08:30:00+05:30'
            ))
        )
    )
);

do $$
begin
    if not exists (
        select 1
        from public.analyzer_notification_deliveries
        where id = '40000000-0000-0000-0000-000000000001'
          and status = 'dismissed'
          and resolved_by = '11111111-1111-1111-1111-111111111111'
          and resolution_action = 'dismissed'
          and resolution_note = 'Verified dismissed backup restore'
    ) then
        raise exception 'Resolved notification delivery did not round-trip through backup restore.';
    end if;
end;
$$;

select 'POSTGRES_INTEGRATION_OK' as result;
