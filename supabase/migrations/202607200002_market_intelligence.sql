begin;

create table if not exists public.market_signal_runs (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    run_type text not null check (run_type in ('daily', 'weekly', 'monthly')),
    as_of timestamptz not null,
    status text not null check (status in ('successful', 'partial', 'failed')),
    model_version text not null,
    macro_regime text,
    dollar_regime text,
    usd_inr_rate numeric,
    data_coverage numeric not null default 0 check (data_coverage between 0 and 1),
    macro jsonb not null default '{}'::jsonb,
    data_issues jsonb not null default '[]'::jsonb,
    portfolio_snapshot jsonb not null default '[]'::jsonb,
    decision_status text not null default 'pending' check (decision_status in ('pending', 'accepted', 'modified', 'skipped')),
    decision_note text,
    created_at timestamptz not null default now(),
    unique (user_id, id)
);

create index if not exists market_signal_runs_user_as_of_idx
    on public.market_signal_runs(user_id, as_of desc);

create table if not exists public.market_signal_scores (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    run_id uuid not null references public.market_signal_runs(id) on delete cascade,
    market_key text not null,
    name text not null,
    symbol text,
    category text,
    final_score numeric not null,
    score_change numeric,
    action text not null,
    confidence numeric not null default 0 check (confidence between 0 and 1),
    actionable boolean not null default false,
    price_as_of date,
    valuation_score numeric,
    technical_score numeric,
    macro_score numeric,
    portfolio_fit_score numeric,
    diversification_score numeric,
    risk_score numeric,
    metrics jsonb not null default '{}'::jsonb,
    labels jsonb not null default '{}'::jsonb,
    reasons jsonb not null default '{}'::jsonb,
    correlations jsonb not null default '{}'::jsonb,
    unique (user_id, run_id, market_key)
);

create index if not exists market_signal_scores_run_idx
    on public.market_signal_scores(user_id, run_id);

create table if not exists public.sip_signal_recommendations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    run_id uuid not null references public.market_signal_runs(id) on delete cascade,
    sip_plan_id uuid references public.sip_plans(id) on delete set null,
    fund_name text not null,
    category_name text,
    planned_amount_inr numeric not null default 0,
    target_only_amount_inr numeric not null default 0,
    suggested_amount_inr numeric not null default 0,
    score numeric,
    confidence numeric not null default 0 check (confidence between 0 and 1),
    risk_score numeric,
    projected_category_percentage numeric,
    reason text,
    unique (user_id, run_id, fund_name)
);

create index if not exists sip_signal_recommendations_run_idx
    on public.sip_signal_recommendations(user_id, run_id);

create table if not exists public.global_signal_recommendations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    run_id uuid not null references public.market_signal_runs(id) on delete cascade,
    instrument text not null,
    amount_inr numeric not null default 0,
    approximate_usd numeric,
    weight_percentage numeric not null default 0,
    score numeric,
    unique (user_id, run_id, instrument)
);

create table if not exists public.market_signal_alerts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    run_id uuid not null references public.market_signal_runs(id) on delete cascade,
    alert_key text,
    alert_type text not null,
    asset text,
    title text not null,
    message text,
    recommended_action text,
    email_delivered boolean not null default false,
    acknowledged_at timestamptz,
    resolved_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists market_signal_alerts_user_created_idx
    on public.market_signal_alerts(user_id, created_at desc);

create table if not exists public.category_signal_mappings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.asset_categories(id) on delete cascade,
    market_key text not null,
    exposure_weight numeric not null check (exposure_weight > 0 and exposure_weight <= 1),
    unique (user_id, category_id, market_key)
);

create table if not exists public.sip_signal_mappings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    sip_plan_id uuid not null references public.sip_plans(id) on delete cascade,
    market_key text not null,
    exposure_weight numeric not null check (exposure_weight > 0 and exposure_weight <= 1),
    unique (user_id, sip_plan_id, market_key)
);

alter table public.market_signal_runs enable row level security;
alter table public.market_signal_scores enable row level security;
alter table public.sip_signal_recommendations enable row level security;
alter table public.global_signal_recommendations enable row level security;
alter table public.market_signal_alerts enable row level security;
alter table public.category_signal_mappings enable row level security;
alter table public.sip_signal_mappings enable row level security;

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'market_signal_runs', 'market_signal_scores', 'sip_signal_recommendations',
        'global_signal_recommendations', 'market_signal_alerts',
        'category_signal_mappings', 'sip_signal_mappings'
    ] loop
        execute format('drop policy if exists "Users manage %1$s" on public.%1$I', table_name);
        execute format(
            'create policy "Users manage %1$s" on public.%1$I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
            table_name
        );
    end loop;
end;
$$;

create or replace function public.ingest_market_signal_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_run_id uuid := (p_run->>'run_id')::uuid;
    v_row jsonb;
begin
    if p_user_id is null or v_run_id is null then
        raise exception 'User id and run id are required.';
    end if;

    insert into public.market_signal_runs(
        id, user_id, run_type, as_of, status, model_version, macro_regime,
        dollar_regime, usd_inr_rate, data_coverage, macro, data_issues, portfolio_snapshot
    ) values (
        v_run_id, p_user_id, p_run->>'run_type', (p_run->>'as_of')::timestamptz,
        p_run->>'status', p_run->>'model_version', p_run->'macro'->>'regime',
        p_run->'macro'->>'dollar', nullif(p_run->'macro'->>'usd_inr', '')::numeric,
        coalesce((p_run->>'data_coverage')::numeric, 0), coalesce(p_run->'macro', '{}'::jsonb),
        coalesce(p_run->'data_issues', '[]'::jsonb), coalesce(p_run->'portfolio_snapshot', '[]'::jsonb)
    ) on conflict (id) do update set
        status = excluded.status,
        macro_regime = excluded.macro_regime,
        dollar_regime = excluded.dollar_regime,
        usd_inr_rate = excluded.usd_inr_rate,
        data_coverage = excluded.data_coverage,
        macro = excluded.macro,
        data_issues = excluded.data_issues,
        portfolio_snapshot = excluded.portfolio_snapshot;

    delete from public.market_signal_scores where user_id = p_user_id and run_id = v_run_id;
    delete from public.sip_signal_recommendations where user_id = p_user_id and run_id = v_run_id;
    delete from public.global_signal_recommendations where user_id = p_user_id and run_id = v_run_id;
    delete from public.market_signal_alerts where user_id = p_user_id and run_id = v_run_id;

    for v_row in select value from jsonb_array_elements(coalesce(p_run->'market_scores', '[]'::jsonb)) loop
        insert into public.market_signal_scores(
            user_id, run_id, market_key, name, symbol, category, final_score, score_change, action,
            confidence, actionable, price_as_of, valuation_score, technical_score,
            macro_score, portfolio_fit_score, diversification_score, risk_score,
            metrics, labels, reasons, correlations
        ) values (
            p_user_id, v_run_id, v_row->>'key', coalesce(v_row->>'name', v_row->>'key'),
            nullif(v_row->>'symbol', ''), v_row->>'category',
            coalesce((v_row->'scores'->>'final')::numeric, 50), nullif(v_row->>'score_change', '')::numeric,
            coalesce(v_row->>'action', 'NO_RECOMMENDATION'),
            coalesce((v_row->'data_quality'->>'confidence')::numeric, 0),
            coalesce((v_row->'data_quality'->>'actionable')::boolean, false),
            nullif(v_row->'metrics'->>'price_as_of', '')::date,
            nullif(v_row->'scores'->>'valuation', '')::numeric,
            nullif(v_row->'scores'->>'momentum', '')::numeric,
            nullif(v_row->'scores'->>'macro', '')::numeric,
            nullif(v_row->'scores'->>'portfolio_fit', '')::numeric,
            nullif(v_row->'scores'->>'diversification', '')::numeric,
            nullif(v_row->'scores'->>'risk', '')::numeric,
            coalesce(v_row->'metrics', '{}'::jsonb), coalesce(v_row->'labels', '{}'::jsonb),
            coalesce(v_row->'reasons', '{}'::jsonb), coalesce(v_row->'corr', '{}'::jsonb)
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_run->'sip_recommendations', '[]'::jsonb)) loop
        insert into public.sip_signal_recommendations(
            user_id, run_id, sip_plan_id, fund_name, category_name, planned_amount_inr,
            target_only_amount_inr, suggested_amount_inr, score, confidence, risk_score,
            projected_category_percentage, reason
        ) values (
            p_user_id, v_run_id, nullif(v_row->>'tracker_sip_plan_id', '')::uuid,
            v_row->>'fund', v_row->>'category', coalesce((v_row->>'planned')::numeric, 0),
            coalesce((v_row->>'target_only')::numeric, 0), coalesce((v_row->>'suggested')::numeric, 0),
            nullif(v_row->>'score', '')::numeric, coalesce((v_row->>'confidence')::numeric, 0),
            nullif(v_row->>'risk_score', '')::numeric, nullif(v_row->>'projected_category_pct', '')::numeric,
            v_row->>'reason'
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_run->'global_recommendations', '[]'::jsonb)) loop
        insert into public.global_signal_recommendations(
            user_id, run_id, instrument, amount_inr, approximate_usd, weight_percentage, score
        ) values (
            p_user_id, v_run_id, v_row->>'instrument', coalesce((v_row->>'amount_inr')::numeric, 0),
            nullif(v_row->>'approx_usd', '')::numeric, coalesce((v_row->>'weight_pct')::numeric, 0),
            nullif(v_row->>'score', '')::numeric
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(p_run->'alerts', '[]'::jsonb)) loop
        insert into public.market_signal_alerts(
            user_id, run_id, alert_key, alert_type, asset, title, message, recommended_action, email_delivered
        ) values (
            p_user_id, v_run_id, v_row->>'alert_key', v_row->>'type', v_row->>'asset',
            v_row->>'title', v_row->>'message', v_row->>'action', coalesce((v_row->>'email_delivered')::boolean, false)
        );
    end loop;
end;
$$;

revoke all on function public.ingest_market_signal_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_market_signal_run(uuid, jsonb) to service_role;

grant select, insert, update, delete on public.market_signal_runs to authenticated;
grant select, insert, update, delete on public.market_signal_scores to authenticated;
grant select, insert, update, delete on public.sip_signal_recommendations to authenticated;
grant select, insert, update, delete on public.global_signal_recommendations to authenticated;
grant select, insert, update, delete on public.market_signal_alerts to authenticated;
grant select, insert, update, delete on public.category_signal_mappings to authenticated;
grant select, insert, update, delete on public.sip_signal_mappings to authenticated;

create or replace function public.restore_complete_portfolio_backup(p_backup jsonb)
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
    if v_user_id is null then raise exception 'Not authenticated'; end if;

    delete from public.market_signal_alerts where user_id = v_user_id;
    delete from public.global_signal_recommendations where user_id = v_user_id;
    delete from public.sip_signal_recommendations where user_id = v_user_id;
    delete from public.market_signal_scores where user_id = v_user_id;
    delete from public.market_signal_runs where user_id = v_user_id;
    delete from public.category_signal_mappings where user_id = v_user_id;
    delete from public.sip_signal_mappings where user_id = v_user_id;

    perform public.restore_portfolio_backup(p_backup);

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'category_signal_mappings', '[]'::jsonb)) loop
        insert into public.category_signal_mappings(id, user_id, category_id, market_key, exposure_weight)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'category_id')::uuid, v_row->>'market_key', (v_row->>'exposure_weight')::numeric);
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'sip_signal_mappings', '[]'::jsonb)) loop
        insert into public.sip_signal_mappings(id, user_id, sip_plan_id, market_key, exposure_weight)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'sip_plan_id')::uuid, v_row->>'market_key', (v_row->>'exposure_weight')::numeric);
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'market_signal_runs', '[]'::jsonb)) loop
        insert into public.market_signal_runs(
            id, user_id, run_type, as_of, status, model_version, macro_regime, dollar_regime,
            usd_inr_rate, data_coverage, macro, data_issues, portfolio_snapshot,
            decision_status, decision_note, created_at
        ) values (
            (v_row->>'id')::uuid, v_user_id, v_row->>'run_type', (v_row->>'as_of')::timestamptz,
            v_row->>'status', v_row->>'model_version', v_row->>'macro_regime', v_row->>'dollar_regime',
            nullif(v_row->>'usd_inr_rate', '')::numeric, coalesce((v_row->>'data_coverage')::numeric, 0),
            coalesce(v_row->'macro', '{}'::jsonb), coalesce(v_row->'data_issues', '[]'::jsonb),
            coalesce(v_row->'portfolio_snapshot', '[]'::jsonb), coalesce(v_row->>'decision_status', 'pending'),
            nullif(v_row->>'decision_note', ''), coalesce(nullif(v_row->>'created_at', '')::timestamptz, now())
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'market_signal_scores', '[]'::jsonb)) loop
        insert into public.market_signal_scores(
            id, user_id, run_id, market_key, name, symbol, category, final_score, score_change, action, confidence,
            actionable, price_as_of, valuation_score, technical_score, macro_score, portfolio_fit_score,
            diversification_score, risk_score, metrics, labels, reasons, correlations
        ) values (
            (v_row->>'id')::uuid, v_user_id, (v_row->>'run_id')::uuid, v_row->>'market_key', v_row->>'name',
            nullif(v_row->>'symbol', ''), v_row->>'category', (v_row->>'final_score')::numeric,
            nullif(v_row->>'score_change', '')::numeric, v_row->>'action',
            coalesce((v_row->>'confidence')::numeric, 0), coalesce((v_row->>'actionable')::boolean, false),
            nullif(v_row->>'price_as_of', '')::date, nullif(v_row->>'valuation_score', '')::numeric,
            nullif(v_row->>'technical_score', '')::numeric, nullif(v_row->>'macro_score', '')::numeric,
            nullif(v_row->>'portfolio_fit_score', '')::numeric, nullif(v_row->>'diversification_score', '')::numeric,
            nullif(v_row->>'risk_score', '')::numeric, coalesce(v_row->'metrics', '{}'::jsonb),
            coalesce(v_row->'labels', '{}'::jsonb), coalesce(v_row->'reasons', '{}'::jsonb),
            coalesce(v_row->'correlations', '{}'::jsonb)
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'sip_signal_recommendations', '[]'::jsonb)) loop
        insert into public.sip_signal_recommendations(
            id, user_id, run_id, sip_plan_id, fund_name, category_name, planned_amount_inr,
            target_only_amount_inr, suggested_amount_inr, score, confidence, risk_score,
            projected_category_percentage, reason
        ) values (
            (v_row->>'id')::uuid, v_user_id, (v_row->>'run_id')::uuid, nullif(v_row->>'sip_plan_id', '')::uuid,
            v_row->>'fund_name', v_row->>'category_name', coalesce((v_row->>'planned_amount_inr')::numeric, 0),
            coalesce((v_row->>'target_only_amount_inr')::numeric, 0), coalesce((v_row->>'suggested_amount_inr')::numeric, 0),
            nullif(v_row->>'score', '')::numeric, coalesce((v_row->>'confidence')::numeric, 0),
            nullif(v_row->>'risk_score', '')::numeric, nullif(v_row->>'projected_category_percentage', '')::numeric,
            v_row->>'reason'
        );
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'global_signal_recommendations', '[]'::jsonb)) loop
        insert into public.global_signal_recommendations(id, user_id, run_id, instrument, amount_inr, approximate_usd, weight_percentage, score)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'run_id')::uuid, v_row->>'instrument',
            coalesce((v_row->>'amount_inr')::numeric, 0), nullif(v_row->>'approximate_usd', '')::numeric,
            coalesce((v_row->>'weight_percentage')::numeric, 0), nullif(v_row->>'score', '')::numeric);
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'market_signal_alerts', '[]'::jsonb)) loop
        insert into public.market_signal_alerts(
            id, user_id, run_id, alert_key, alert_type, asset, title, message, recommended_action,
            email_delivered, acknowledged_at, resolved_at, created_at
        ) values (
            (v_row->>'id')::uuid, v_user_id, (v_row->>'run_id')::uuid, v_row->>'alert_key', v_row->>'alert_type',
            v_row->>'asset', v_row->>'title', v_row->>'message', v_row->>'recommended_action',
            coalesce((v_row->>'email_delivered')::boolean, false), nullif(v_row->>'acknowledged_at', '')::timestamptz,
            nullif(v_row->>'resolved_at', '')::timestamptz, coalesce(nullif(v_row->>'created_at', '')::timestamptz, now())
        );
    end loop;
end;
$$;

revoke all on function public.restore_complete_portfolio_backup(jsonb) from public, anon;
grant execute on function public.restore_complete_portfolio_backup(jsonb) to authenticated;

create or replace function public.replace_sip_signal_mappings(p_sip_plan_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_total numeric;
begin
    if not exists (select 1 from public.sip_plans where id = p_sip_plan_id and user_id = v_user_id) then
        raise exception 'Invalid SIP plan.';
    end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'At least one signal mapping is required.';
    end if;
    select sum((value->>'exposure_weight')::numeric) into v_total from jsonb_array_elements(p_rows);
    if abs(v_total - 1) > 0.0001 then raise exception 'SIP signal weights must total 100%%.'; end if;
    delete from public.sip_signal_mappings where user_id = v_user_id and sip_plan_id = p_sip_plan_id;
    for v_row in select value from jsonb_array_elements(p_rows) loop
        if trim(coalesce(v_row->>'market_key', '')) = '' or (v_row->>'exposure_weight')::numeric <= 0 then
            raise exception 'Invalid signal mapping.';
        end if;
        insert into public.sip_signal_mappings(user_id, sip_plan_id, market_key, exposure_weight)
        values (v_user_id, p_sip_plan_id, upper(trim(v_row->>'market_key')), (v_row->>'exposure_weight')::numeric);
    end loop;
end;
$$;

create or replace function public.replace_category_signal_mappings(p_category_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_total numeric;
begin
    if not exists (select 1 from public.asset_categories where id = p_category_id and user_id = v_user_id) then
        raise exception 'Invalid category.';
    end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'At least one signal mapping is required.';
    end if;
    select sum((value->>'exposure_weight')::numeric) into v_total from jsonb_array_elements(p_rows);
    if abs(v_total - 1) > 0.0001 then raise exception 'Category signal weights must total 100%%.'; end if;
    delete from public.category_signal_mappings where user_id = v_user_id and category_id = p_category_id;
    for v_row in select value from jsonb_array_elements(p_rows) loop
        if trim(coalesce(v_row->>'market_key', '')) = '' or (v_row->>'exposure_weight')::numeric <= 0 then
            raise exception 'Invalid signal mapping.';
        end if;
        insert into public.category_signal_mappings(user_id, category_id, market_key, exposure_weight)
        values (v_user_id, p_category_id, upper(trim(v_row->>'market_key')), (v_row->>'exposure_weight')::numeric);
    end loop;
end;
$$;

revoke all on function public.replace_sip_signal_mappings(uuid, jsonb) from public, anon;
revoke all on function public.replace_category_signal_mappings(uuid, jsonb) from public, anon;
grant execute on function public.replace_sip_signal_mappings(uuid, jsonb) to authenticated;
grant execute on function public.replace_category_signal_mappings(uuid, jsonb) to authenticated;

commit;
