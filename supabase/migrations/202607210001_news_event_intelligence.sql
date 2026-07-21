begin;

create table if not exists public.news_settings (
    user_id uuid primary key references auth.users(id) on delete cascade,
    is_enabled boolean not null default true,
    ai_enrichment_enabled boolean not null default true,
    immediate_alert_threshold numeric not null default 80 check (immediate_alert_threshold between 0 and 100),
    portfolio_relevance_threshold numeric not null default 25 check (portfolio_relevance_threshold between 0 and 100),
    digest_hour_ist integer not null default 18 check (digest_hour_ist between 0 and 23),
    send_daily_digest boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.news_sources (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    source_key text not null,
    name text not null,
    source_type text not null check (source_type in ('official_rss', 'news_rss', 'api')),
    credibility_tier integer not null check (credibility_tier between 1 and 4),
    url text not null,
    is_active boolean not null default true,
    last_fetched_at timestamptz,
    last_success_at timestamptz,
    last_error text,
    consecutive_failures integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, source_key)
);

create table if not exists public.news_pipeline_runs (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    as_of timestamptz not null,
    status text not null check (status in ('successful', 'partial', 'failed')),
    model_version text not null,
    source_count integer not null default 0,
    fetched_count integer not null default 0,
    new_article_count integer not null default 0,
    event_count integer not null default 0,
    high_impact_count integer not null default 0,
    ai_enriched_count integer not null default 0,
    data_issues jsonb not null default '[]'::jsonb,
    duration_seconds numeric,
    created_at timestamptz not null default now(),
    unique (user_id, id)
);

create table if not exists public.news_articles (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    source_id uuid not null references public.news_sources(id) on delete cascade,
    external_id text not null,
    title text not null,
    summary text,
    url text not null,
    canonical_url text not null,
    published_at timestamptz not null,
    language text not null default 'en',
    content_hash text not null,
    entities jsonb not null default '{}'::jsonb,
    raw_metadata jsonb not null default '{}'::jsonb,
    first_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, source_id, external_id)
);

create index if not exists news_articles_user_published_idx
    on public.news_articles(user_id, published_at desc);
create index if not exists news_articles_user_hash_idx
    on public.news_articles(user_id, content_hash);

create table if not exists public.market_events (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    event_key text not null,
    event_type text not null,
    headline text not null,
    summary text not null,
    event_status text not null default 'reported' check (event_status in ('reported', 'confirmed', 'conflicting', 'retracted', 'resolved')),
    posture text not null default 'MIXED' check (posture in ('RISK_ON', 'RISK_OFF', 'MIXED', 'NEUTRAL')),
    first_reported_at timestamptz not null,
    last_updated_at timestamptz not null,
    credibility_score numeric not null check (credibility_score between 0 and 100),
    impact_score numeric not null check (impact_score between 0 and 100),
    urgency_score numeric not null check (urgency_score between 0 and 100),
    novelty_score numeric not null check (novelty_score between 0 and 100),
    market_confirmation_score numeric not null default 0 check (market_confirmation_score between 0 and 100),
    portfolio_relevance_score numeric not null default 0 check (portfolio_relevance_score between 0 and 100),
    time_horizon text not null default 'days' check (time_horizon in ('hours', 'days', 'days_to_weeks', 'weeks_to_months', 'structural')),
    countries jsonb not null default '[]'::jsonb,
    people jsonb not null default '[]'::jsonb,
    companies jsonb not null default '[]'::jsonb,
    sectors jsonb not null default '[]'::jsonb,
    themes jsonb not null default '[]'::jsonb,
    source_count integer not null default 0,
    article_count integer not null default 0,
    primary_source_available boolean not null default false,
    ai_enriched boolean not null default false,
    ai_model text,
    assessment_version text not null,
    automatic_outcome_label text not null default 'pending' check (automatic_outcome_label in ('pending', 'supported', 'mixed', 'contradicted', 'unconfirmed', 'too_early')),
    manual_outcome_label text not null default 'unreviewed' check (manual_outcome_label in ('unreviewed', 'correct', 'partial', 'false_positive', 'unverifiable')),
    manual_review_notes text,
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, event_key)
);

create index if not exists market_events_user_updated_idx
    on public.market_events(user_id, last_updated_at desc);
create index if not exists market_events_user_impact_idx
    on public.market_events(user_id, impact_score desc, last_updated_at desc);

create table if not exists public.market_event_articles (
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.market_events(id) on delete cascade,
    article_id uuid not null references public.news_articles(id) on delete cascade,
    similarity_score numeric not null default 1 check (similarity_score between 0 and 1),
    created_at timestamptz not null default now(),
    primary key (event_id, article_id)
);

create table if not exists public.market_event_impacts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.market_events(id) on delete cascade,
    market_key text not null,
    direction numeric not null check (direction between -1 and 1),
    magnitude numeric not null check (magnitude between 0 and 1),
    confidence numeric not null check (confidence between 0 and 1),
    time_horizon text not null,
    reason text not null,
    origin text not null check (origin in ('rule', 'ai', 'rule_and_ai')),
    rule_keys jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, event_id, market_key)
);

create table if not exists public.market_event_reactions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.market_events(id) on delete cascade,
    market_key text not null,
    symbol text not null,
    baseline_at timestamptz,
    baseline_price numeric,
    observed_at timestamptz,
    observed_price numeric,
    return_percentage numeric,
    benchmark_return_percentage numeric,
    abnormal_return_percentage numeric,
    reaction_z_score numeric,
    confirmation_status text not null check (confirmation_status in ('too_early', 'unconfirmed', 'confirmed', 'contradicted', 'unavailable')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, event_id, market_key)
);

create table if not exists public.portfolio_event_impacts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.market_events(id) on delete cascade,
    category_id uuid references public.asset_categories(id) on delete set null,
    category_name text not null,
    portfolio_weight_percentage numeric not null default 0,
    direction numeric not null check (direction between -1 and 1),
    relevance_score numeric not null check (relevance_score between 0 and 100),
    confidence numeric not null check (confidence between 0 and 1),
    reason text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, event_id, category_name)
);

create table if not exists public.news_event_evaluations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid not null references public.market_events(id) on delete cascade,
    evaluated_at timestamptz not null,
    evaluation_type text not null check (evaluation_type in ('automatic', 'manual')),
    label text not null check (label in ('pending', 'supported', 'mixed', 'contradicted', 'unconfirmed', 'too_early', 'correct', 'partial', 'false_positive', 'unverifiable')),
    confirmed_impact_count integer not null default 0,
    contradicted_impact_count integer not null default 0,
    unavailable_impact_count integer not null default 0,
    notes text,
    evidence jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (user_id, event_id, evaluated_at, evaluation_type)
);

create index if not exists news_event_evaluations_user_date_idx
    on public.news_event_evaluations(user_id, evaluated_at desc);

create table if not exists public.market_event_alerts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_id uuid references public.market_events(id) on delete cascade,
    alert_key text not null,
    alert_type text not null check (alert_type in ('high_impact', 'daily_digest')),
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'suppressed')),
    reason text not null,
    created_at timestamptz not null default now(),
    delivered_at timestamptz,
    delivery_error text,
    unique (user_id, alert_key)
);

alter table public.news_settings enable row level security;
alter table public.news_sources enable row level security;
alter table public.news_pipeline_runs enable row level security;
alter table public.news_articles enable row level security;
alter table public.market_events enable row level security;
alter table public.market_event_articles enable row level security;
alter table public.market_event_impacts enable row level security;
alter table public.market_event_reactions enable row level security;
alter table public.portfolio_event_impacts enable row level security;
alter table public.news_event_evaluations enable row level security;
alter table public.market_event_alerts enable row level security;

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'news_settings', 'news_sources', 'news_pipeline_runs', 'news_articles',
        'market_events', 'market_event_articles', 'market_event_impacts',
        'market_event_reactions', 'portfolio_event_impacts',
        'news_event_evaluations', 'market_event_alerts'
    ] loop
        execute format('drop policy if exists "Users manage %1$s" on public.%1$I', table_name);
        execute format(
            'create policy "Users manage %1$s" on public.%1$I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
            table_name
        );
    end loop;
end;
$$;

drop trigger if exists news_settings_set_updated_at on public.news_settings;
create trigger news_settings_set_updated_at before update on public.news_settings
for each row execute function public.set_updated_at();
drop trigger if exists news_sources_set_updated_at on public.news_sources;
create trigger news_sources_set_updated_at before update on public.news_sources
for each row execute function public.set_updated_at();
drop trigger if exists news_articles_set_updated_at on public.news_articles;
create trigger news_articles_set_updated_at before update on public.news_articles
for each row execute function public.set_updated_at();
drop trigger if exists market_events_set_updated_at on public.market_events;
create trigger market_events_set_updated_at before update on public.market_events
for each row execute function public.set_updated_at();
drop trigger if exists market_event_impacts_set_updated_at on public.market_event_impacts;
create trigger market_event_impacts_set_updated_at before update on public.market_event_impacts
for each row execute function public.set_updated_at();
drop trigger if exists market_event_reactions_set_updated_at on public.market_event_reactions;
create trigger market_event_reactions_set_updated_at before update on public.market_event_reactions
for each row execute function public.set_updated_at();
drop trigger if exists portfolio_event_impacts_set_updated_at on public.portfolio_event_impacts;
create trigger portfolio_event_impacts_set_updated_at before update on public.portfolio_event_impacts
for each row execute function public.set_updated_at();

insert into public.news_settings(user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.ingest_news_event_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_source jsonb;
    v_article jsonb;
    v_event jsonb;
    v_impact jsonb;
    v_reaction jsonb;
    v_portfolio jsonb;
    v_evaluation jsonb;
    v_article_link jsonb;
    v_alert jsonb;
    v_event_id uuid;
begin
    if p_user_id is null then raise exception 'User id is required.'; end if;

    insert into public.news_pipeline_runs(
        id, user_id, as_of, status, model_version, source_count, fetched_count,
        new_article_count, event_count, high_impact_count, ai_enriched_count,
        data_issues, duration_seconds
    ) values (
        (p_run->>'run_id')::uuid, p_user_id, (p_run->>'as_of')::timestamptz,
        p_run->>'status', p_run->>'model_version',
        coalesce((p_run->>'source_count')::integer, 0),
        coalesce((p_run->>'fetched_count')::integer, 0),
        coalesce((p_run->>'new_article_count')::integer, 0),
        coalesce((p_run->>'event_count')::integer, 0),
        coalesce((p_run->>'high_impact_count')::integer, 0),
        coalesce((p_run->>'ai_enriched_count')::integer, 0),
        coalesce(p_run->'data_issues', '[]'::jsonb),
        nullif(p_run->>'duration_seconds', '')::numeric
    ) on conflict (id) do update set
        status = excluded.status, data_issues = excluded.data_issues,
        duration_seconds = excluded.duration_seconds;

    for v_source in select value from jsonb_array_elements(coalesce(p_run->'sources', '[]'::jsonb)) loop
        insert into public.news_sources(
            id, user_id, source_key, name, source_type, credibility_tier, url,
            is_active, last_fetched_at, last_success_at, last_error, consecutive_failures
        ) values (
            (v_source->>'id')::uuid, p_user_id, v_source->>'source_key', v_source->>'name',
            v_source->>'source_type', (v_source->>'credibility_tier')::integer,
            v_source->>'url', coalesce((v_source->>'is_active')::boolean, true),
            nullif(v_source->>'last_fetched_at', '')::timestamptz,
            nullif(v_source->>'last_success_at', '')::timestamptz,
            nullif(v_source->>'last_error', ''), coalesce((v_source->>'consecutive_failures')::integer, 0)
        ) on conflict (user_id, source_key) do update set
            name = excluded.name, source_type = excluded.source_type,
            credibility_tier = excluded.credibility_tier, url = excluded.url,
            is_active = excluded.is_active, last_fetched_at = excluded.last_fetched_at,
            last_success_at = excluded.last_success_at, last_error = excluded.last_error,
            consecutive_failures = excluded.consecutive_failures;
    end loop;

    for v_article in select value from jsonb_array_elements(coalesce(p_run->'articles', '[]'::jsonb)) loop
        insert into public.news_articles(
            id, user_id, source_id, external_id, title, summary, url, canonical_url,
            published_at, language, content_hash, entities, raw_metadata, first_seen_at
        ) values (
            (v_article->>'id')::uuid, p_user_id, (v_article->>'source_id')::uuid,
            v_article->>'external_id', v_article->>'title', nullif(v_article->>'summary', ''),
            v_article->>'url', v_article->>'canonical_url', (v_article->>'published_at')::timestamptz,
            coalesce(v_article->>'language', 'en'), v_article->>'content_hash',
            coalesce(v_article->'entities', '{}'::jsonb), coalesce(v_article->'raw_metadata', '{}'::jsonb),
            coalesce(nullif(v_article->>'first_seen_at', '')::timestamptz, now())
        ) on conflict (user_id, source_id, external_id) do update set
            title = excluded.title, summary = excluded.summary, url = excluded.url,
            canonical_url = excluded.canonical_url, published_at = excluded.published_at,
            entities = excluded.entities, raw_metadata = excluded.raw_metadata;
    end loop;

    for v_event in select value from jsonb_array_elements(coalesce(p_run->'events', '[]'::jsonb)) loop
        v_event_id := (v_event->>'id')::uuid;
        insert into public.market_events(
            id, user_id, event_key, event_type, headline, summary, event_status, posture,
            first_reported_at, last_updated_at, credibility_score, impact_score,
            urgency_score, novelty_score, market_confirmation_score, portfolio_relevance_score,
            time_horizon, countries, people, companies, sectors, themes, source_count,
            article_count, primary_source_available, ai_enriched, ai_model,
            assessment_version, automatic_outcome_label
        ) values (
            v_event_id, p_user_id, v_event->>'event_key', v_event->>'event_type',
            v_event->>'headline', v_event->>'summary', coalesce(v_event->>'event_status', 'reported'),
            coalesce(v_event->>'posture', 'MIXED'), (v_event->>'first_reported_at')::timestamptz,
            (v_event->>'last_updated_at')::timestamptz, (v_event->>'credibility_score')::numeric,
            (v_event->>'impact_score')::numeric, (v_event->>'urgency_score')::numeric,
            (v_event->>'novelty_score')::numeric, coalesce((v_event->>'market_confirmation_score')::numeric, 0),
            coalesce((v_event->>'portfolio_relevance_score')::numeric, 0),
            coalesce(v_event->>'time_horizon', 'days'), coalesce(v_event->'countries', '[]'::jsonb),
            coalesce(v_event->'people', '[]'::jsonb), coalesce(v_event->'companies', '[]'::jsonb),
            coalesce(v_event->'sectors', '[]'::jsonb), coalesce(v_event->'themes', '[]'::jsonb),
            coalesce((v_event->>'source_count')::integer, 0), coalesce((v_event->>'article_count')::integer, 0),
            coalesce((v_event->>'primary_source_available')::boolean, false),
            coalesce((v_event->>'ai_enriched')::boolean, false), nullif(v_event->>'ai_model', ''),
            v_event->>'assessment_version', coalesce(v_event->>'automatic_outcome_label', 'pending')
        ) on conflict (user_id, event_key) do update set
            event_type = excluded.event_type, headline = excluded.headline, summary = excluded.summary,
            event_status = excluded.event_status, posture = excluded.posture,
            first_reported_at = least(public.market_events.first_reported_at, excluded.first_reported_at),
            last_updated_at = greatest(public.market_events.last_updated_at, excluded.last_updated_at),
            credibility_score = excluded.credibility_score, impact_score = excluded.impact_score,
            urgency_score = excluded.urgency_score, novelty_score = excluded.novelty_score,
            market_confirmation_score = excluded.market_confirmation_score,
            portfolio_relevance_score = excluded.portfolio_relevance_score,
            time_horizon = excluded.time_horizon, countries = excluded.countries,
            people = excluded.people, companies = excluded.companies, sectors = excluded.sectors,
            themes = excluded.themes, source_count = excluded.source_count,
            article_count = excluded.article_count, primary_source_available = excluded.primary_source_available,
            ai_enriched = excluded.ai_enriched, ai_model = excluded.ai_model,
            assessment_version = excluded.assessment_version,
            automatic_outcome_label = excluded.automatic_outcome_label
        returning id into v_event_id;

        for v_article_link in select value from jsonb_array_elements(coalesce(v_event->'article_links', '[]'::jsonb)) loop
            insert into public.market_event_articles(user_id, event_id, article_id, similarity_score)
            values (p_user_id, v_event_id, (v_article_link->>'article_id')::uuid,
                coalesce((v_article_link->>'similarity_score')::numeric, 1))
            on conflict (event_id, article_id) do update set similarity_score = excluded.similarity_score;
        end loop;

        delete from public.market_event_impacts where user_id = p_user_id and event_id = v_event_id;
        for v_impact in select value from jsonb_array_elements(coalesce(v_event->'impacts', '[]'::jsonb)) loop
            insert into public.market_event_impacts(
                user_id, event_id, market_key, direction, magnitude, confidence,
                time_horizon, reason, origin, rule_keys
            ) values (
                p_user_id, v_event_id, v_impact->>'market_key', (v_impact->>'direction')::numeric,
                (v_impact->>'magnitude')::numeric, (v_impact->>'confidence')::numeric,
                v_impact->>'time_horizon', v_impact->>'reason', v_impact->>'origin',
                coalesce(v_impact->'rule_keys', '[]'::jsonb)
            );
        end loop;

        delete from public.market_event_reactions where user_id = p_user_id and event_id = v_event_id;
        for v_reaction in select value from jsonb_array_elements(coalesce(v_event->'reactions', '[]'::jsonb)) loop
            insert into public.market_event_reactions(
                user_id, event_id, market_key, symbol, baseline_at, baseline_price,
                observed_at, observed_price, return_percentage, benchmark_return_percentage,
                abnormal_return_percentage, reaction_z_score, confirmation_status
            ) values (
                p_user_id, v_event_id, v_reaction->>'market_key', v_reaction->>'symbol',
                nullif(v_reaction->>'baseline_at', '')::timestamptz, nullif(v_reaction->>'baseline_price', '')::numeric,
                nullif(v_reaction->>'observed_at', '')::timestamptz, nullif(v_reaction->>'observed_price', '')::numeric,
                nullif(v_reaction->>'return_percentage', '')::numeric,
                nullif(v_reaction->>'benchmark_return_percentage', '')::numeric,
                nullif(v_reaction->>'abnormal_return_percentage', '')::numeric,
                nullif(v_reaction->>'reaction_z_score', '')::numeric,
                v_reaction->>'confirmation_status'
            );
        end loop;

        delete from public.portfolio_event_impacts where user_id = p_user_id and event_id = v_event_id;
        for v_portfolio in select value from jsonb_array_elements(coalesce(v_event->'portfolio_impacts', '[]'::jsonb)) loop
            insert into public.portfolio_event_impacts(
                user_id, event_id, category_id, category_name, portfolio_weight_percentage,
                direction, relevance_score, confidence, reason
            ) values (
                p_user_id, v_event_id, nullif(v_portfolio->>'category_id', '')::uuid,
                v_portfolio->>'category_name', coalesce((v_portfolio->>'portfolio_weight_percentage')::numeric, 0),
                (v_portfolio->>'direction')::numeric, (v_portfolio->>'relevance_score')::numeric,
                (v_portfolio->>'confidence')::numeric, v_portfolio->>'reason'
            );
        end loop;

        v_evaluation := v_event->'evaluation';
        if v_evaluation is not null and v_evaluation <> 'null'::jsonb then
            insert into public.news_event_evaluations(
                user_id, event_id, evaluated_at, evaluation_type, label,
                confirmed_impact_count, contradicted_impact_count, unavailable_impact_count,
                notes, evidence
            ) values (
                p_user_id, v_event_id, (v_evaluation->>'evaluated_at')::timestamptz,
                'automatic', v_evaluation->>'label',
                coalesce((v_evaluation->>'confirmed_impact_count')::integer, 0),
                coalesce((v_evaluation->>'contradicted_impact_count')::integer, 0),
                coalesce((v_evaluation->>'unavailable_impact_count')::integer, 0),
                nullif(v_evaluation->>'notes', ''), coalesce(v_evaluation->'evidence', '{}'::jsonb)
            ) on conflict (user_id, event_id, evaluated_at, evaluation_type) do update set
                label = excluded.label, confirmed_impact_count = excluded.confirmed_impact_count,
                contradicted_impact_count = excluded.contradicted_impact_count,
                unavailable_impact_count = excluded.unavailable_impact_count,
                notes = excluded.notes, evidence = excluded.evidence;
        end if;
    end loop;

    for v_alert in select value from jsonb_array_elements(coalesce(p_run->'alerts', '[]'::jsonb)) loop
        insert into public.market_event_alerts(user_id, event_id, alert_key, alert_type, status, reason)
        values (p_user_id, nullif(v_alert->>'event_id', '')::uuid, v_alert->>'alert_key',
            v_alert->>'alert_type', coalesce(v_alert->>'status', 'pending'), v_alert->>'reason')
        on conflict (user_id, alert_key) do update set
            event_id = excluded.event_id,
            reason = excluded.reason,
            status = case
                when public.market_event_alerts.status = 'sent' then 'sent'
                else 'pending'
            end,
            delivery_error = case
                when public.market_event_alerts.status = 'sent' then public.market_event_alerts.delivery_error
                else null
            end;
    end loop;
end;
$$;

create or replace function public.restore_news_event_backup(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_data jsonb := coalesce(p_backup->'data', '{}'::jsonb);
    v_table text;
    v_rows jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    foreach v_table in array array[
        'news_settings', 'news_sources', 'news_pipeline_runs', 'news_articles',
        'market_events', 'market_event_articles', 'market_event_impacts',
        'market_event_reactions', 'portfolio_event_impacts',
        'news_event_evaluations', 'market_event_alerts'
    ] loop
        v_rows := coalesce(v_data->v_table, '[]'::jsonb);
        if jsonb_typeof(v_rows) <> 'array' then
            raise exception 'Backup table % must be an array.', v_table;
        end if;
        if exists (
            select 1
            from jsonb_array_elements(v_rows) as item
            where nullif(item->>'user_id', '')::uuid is distinct from v_user_id
        ) then
            raise exception 'Backup table % contains rows for another user.', v_table;
        end if;
    end loop;

    foreach v_table in array array[
        'market_event_alerts', 'news_event_evaluations', 'portfolio_event_impacts',
        'market_event_reactions', 'market_event_impacts', 'market_event_articles',
        'market_events', 'news_articles', 'news_pipeline_runs', 'news_sources',
        'news_settings'
    ] loop
        execute format('delete from public.%I where user_id = $1', v_table) using v_user_id;
    end loop;

    foreach v_table in array array[
        'news_settings', 'news_sources', 'news_pipeline_runs', 'news_articles',
        'market_events', 'market_event_articles', 'market_event_impacts',
        'market_event_reactions', 'portfolio_event_impacts',
        'news_event_evaluations', 'market_event_alerts'
    ] loop
        v_rows := coalesce(v_data->v_table, '[]'::jsonb);
        if jsonb_array_length(v_rows) > 0 then
            execute format(
                'insert into public.%1$I select * from jsonb_populate_recordset(null::public.%1$I, $1)',
                v_table
            ) using v_rows;
        end if;
    end loop;

    insert into public.news_settings(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v3(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.restore_complete_portfolio_backup_v2(p_backup);
    perform public.restore_news_event_backup(p_backup);
end;
$$;

create or replace function public.mark_news_alert_delivery(
    p_user_id uuid,
    p_alert_keys text[],
    p_status text,
    p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    if p_status not in ('sent', 'failed', 'suppressed') then raise exception 'Invalid alert delivery status.'; end if;
    update public.market_event_alerts
    set status = p_status,
        delivered_at = case when p_status = 'sent' then now() else delivered_at end,
        delivery_error = nullif(p_error, '')
    where user_id = p_user_id and alert_key = any(p_alert_keys);
end;
$$;

create or replace function public.save_news_settings(
    p_is_enabled boolean,
    p_ai_enrichment_enabled boolean,
    p_immediate_alert_threshold numeric,
    p_portfolio_relevance_threshold numeric,
    p_digest_hour_ist integer,
    p_send_daily_digest boolean
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
    if p_immediate_alert_threshold < 0 or p_immediate_alert_threshold > 100 then raise exception 'Immediate threshold must be between 0 and 100.'; end if;
    if p_portfolio_relevance_threshold < 0 or p_portfolio_relevance_threshold > 100 then raise exception 'Portfolio threshold must be between 0 and 100.'; end if;
    if p_digest_hour_ist < 0 or p_digest_hour_ist > 23 then raise exception 'Digest hour must be between 0 and 23.'; end if;
    insert into public.news_settings(
        user_id, is_enabled, ai_enrichment_enabled, immediate_alert_threshold,
        portfolio_relevance_threshold, digest_hour_ist, send_daily_digest
    ) values (
        v_user_id, p_is_enabled, p_ai_enrichment_enabled, p_immediate_alert_threshold,
        p_portfolio_relevance_threshold, p_digest_hour_ist, p_send_daily_digest
    ) on conflict (user_id) do update set
        is_enabled = excluded.is_enabled,
        ai_enrichment_enabled = excluded.ai_enrichment_enabled,
        immediate_alert_threshold = excluded.immediate_alert_threshold,
        portfolio_relevance_threshold = excluded.portfolio_relevance_threshold,
        digest_hour_ist = excluded.digest_hour_ist,
        send_daily_digest = excluded.send_daily_digest;
end;
$$;

create or replace function public.review_news_event(
    p_event_id uuid,
    p_label text,
    p_notes text default null
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
    if p_label not in ('correct', 'partial', 'false_positive', 'unverifiable') then raise exception 'Invalid review label.'; end if;
    update public.market_events
    set manual_outcome_label = p_label, manual_review_notes = nullif(trim(p_notes), ''), reviewed_at = now()
    where id = p_event_id and user_id = v_user_id;
    if not found then raise exception 'Event not found.'; end if;
    insert into public.news_event_evaluations(
        user_id, event_id, evaluated_at, evaluation_type, label, notes
    ) values (v_user_id, p_event_id, now(), 'manual', p_label, nullif(trim(p_notes), ''));
end;
$$;

revoke all on function public.ingest_news_event_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.mark_news_alert_delivery(uuid, text[], text, text) from public, anon, authenticated;
grant execute on function public.ingest_news_event_run(uuid, jsonb) to service_role;
grant execute on function public.mark_news_alert_delivery(uuid, text[], text, text) to service_role;

grant select, insert, update, delete on public.news_settings to authenticated;
grant select, insert, update, delete on public.news_sources to authenticated;
grant select, insert, update, delete on public.news_pipeline_runs to authenticated;
grant select, insert, update, delete on public.news_articles to authenticated;
grant select, insert, update, delete on public.market_events to authenticated;
grant select, insert, update, delete on public.market_event_articles to authenticated;
grant select, insert, update, delete on public.market_event_impacts to authenticated;
grant select, insert, update, delete on public.market_event_reactions to authenticated;
grant select, insert, update, delete on public.portfolio_event_impacts to authenticated;
grant select, insert, update, delete on public.news_event_evaluations to authenticated;
grant select, insert, update, delete on public.market_event_alerts to authenticated;
grant execute on function public.save_news_settings(boolean, boolean, numeric, numeric, integer, boolean) to authenticated;
grant execute on function public.review_news_event(uuid, text, text) to authenticated;
grant execute on function public.restore_news_event_backup(jsonb) to authenticated;
grant execute on function public.restore_complete_portfolio_backup_v3(jsonb) to authenticated;

commit;
