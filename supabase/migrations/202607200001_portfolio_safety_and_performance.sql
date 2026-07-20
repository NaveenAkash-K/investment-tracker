begin;

alter table public.asset_categories
    add column if not exists tracking_currency text not null default 'INR';

alter table public.asset_categories
    drop constraint if exists asset_categories_tracking_currency_check;

alter table public.asset_categories
    add constraint asset_categories_tracking_currency_check
    check (tracking_currency in ('INR', 'USD'));

alter table public.portfolio_snapshots
    add column if not exists total_contribution_inr numeric not null default 0,
    add column if not exists market_gain_inr numeric not null default 0,
    add column if not exists currency_gain_inr numeric not null default 0,
    add column if not exists combined_gain_inr numeric not null default 0;

create table if not exists public.monthly_category_performance (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.asset_categories(id) on delete restrict,
    performance_month date not null,
    tracking_currency text not null check (tracking_currency in ('INR', 'USD')),
    is_baseline boolean not null default false,
    opening_native_value numeric not null default 0 check (opening_native_value >= 0),
    opening_fx_rate numeric not null default 1 check (opening_fx_rate > 0),
    contribution_inr numeric not null default 0 check (contribution_inr >= 0),
    contribution_native numeric not null default 0 check (contribution_native >= 0),
    contribution_fx_rate numeric not null default 1 check (contribution_fx_rate > 0),
    closing_native_value numeric not null default 0 check (closing_native_value >= 0),
    closing_fx_rate numeric not null default 1 check (closing_fx_rate > 0),
    opening_value_inr numeric not null default 0,
    closing_value_inr numeric not null default 0,
    market_gain_native numeric not null default 0,
    market_gain_inr numeric not null default 0,
    currency_gain_inr numeric not null default 0,
    combined_gain_inr numeric not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, category_id, performance_month)
);

create index if not exists monthly_category_performance_user_month_idx
    on public.monthly_category_performance(user_id, performance_month desc);

alter table public.monthly_category_performance enable row level security;

drop policy if exists "Users manage their monthly performance" on public.monthly_category_performance;
create policy "Users manage their monthly performance"
    on public.monthly_category_performance
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

with ranked_notes as (
    select id,
           row_number() over (
               partition by user_id
               order by updated_at desc nulls last, created_at desc nulls last, id
           ) as note_rank
    from public.investment_notes
    where is_current = true
)
update public.investment_notes notes
set is_current = false
from ranked_notes ranked
where notes.id = ranked.id
  and ranked.note_rank > 1;

with latest_note as (
    select distinct on (user_id) id
    from public.investment_notes notes
    where not exists (
        select 1 from public.investment_notes current_note
        where current_note.user_id = notes.user_id and current_note.is_current = true
    )
    order by user_id, updated_at desc nulls last, created_at desc nulls last, id
)
update public.investment_notes notes
set is_current = true
from latest_note
where notes.id = latest_note.id;

create unique index if not exists investment_notes_one_current_per_user_idx
    on public.investment_notes(user_id)
    where is_current = true;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists monthly_category_performance_set_updated_at
    on public.monthly_category_performance;
create trigger monthly_category_performance_set_updated_at
before update on public.monthly_category_performance
for each row execute function public.set_updated_at();

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
                    (v_opening_native * (v_closing_fx - v_opening_fx)) +
                    (v_contribution_native * (v_closing_fx - v_contribution_fx))
            end;
            v_combined_inr := v_market_inr + v_currency_inr;
        end if;

        insert into public.monthly_category_performance (
            user_id,
            category_id,
            performance_month,
            tracking_currency,
            is_baseline,
            opening_native_value,
            opening_fx_rate,
            contribution_inr,
            contribution_native,
            contribution_fx_rate,
            closing_native_value,
            closing_fx_rate,
            opening_value_inr,
            closing_value_inr,
            market_gain_native,
            market_gain_inr,
            currency_gain_inr,
            combined_gain_inr
        ) values (
            v_user_id,
            v_category_id,
            p_month,
            v_currency,
            not v_has_previous,
            v_opening_native,
            v_opening_fx,
            v_contribution_inr,
            v_contribution_native,
            v_contribution_fx,
            v_closing_native,
            v_closing_fx,
            v_opening_inr,
            v_closing_inr,
            v_market_native,
            v_market_inr,
            v_currency_inr,
            v_combined_inr
        )
        on conflict (user_id, category_id, performance_month)
        do update set
            tracking_currency = excluded.tracking_currency,
            is_baseline = excluded.is_baseline,
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
                last_updated_at = (p_month + interval '1 month - 1 day')::date
            where user_id = v_user_id
              and category_id = v_category_id
              and currency = 'USD'
              and is_active = true;
        end if;
    end loop;
end;
$$;

create or replace function public.bulk_update_holdings(
    p_rows jsonb,
    p_updated_on date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_holding public.holdings%rowtype;
    v_value numeric;
    v_rate numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    for v_row in select value from jsonb_array_elements(p_rows)
    loop
        select * into v_holding
        from public.holdings
        where id = (v_row->>'id')::uuid and user_id = v_user_id;

        if not found then raise exception 'Invalid holding.'; end if;

        v_value := (v_row->>'current_value')::numeric;
        v_rate := case
            when v_holding.currency = 'INR' then 1
            else (v_row->>'exchange_rate_to_inr')::numeric
        end;

        if v_value < 0 or v_rate <= 0 then raise exception 'Invalid holding value.'; end if;

        update public.holdings
        set current_value = v_value,
            exchange_rate_to_inr = v_rate,
            last_updated_at = p_updated_on
        where id = v_holding.id and user_id = v_user_id;
    end loop;
end;
$$;

create or replace function public.bulk_update_sip_plans(p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_amount numeric;
    v_day integer;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    for v_row in select value from jsonb_array_elements(p_rows)
    loop
        v_amount := (v_row->>'monthly_amount')::numeric;
        v_day := nullif(v_row->>'sip_day', '')::integer;

        if v_amount < 0 or (v_day is not null and (v_day < 1 or v_day > 31)) then
            raise exception 'Invalid SIP value.';
        end if;

        update public.sip_plans
        set monthly_amount = v_amount, sip_day = v_day
        where id = (v_row->>'id')::uuid and user_id = v_user_id;

        if not found then raise exception 'Invalid SIP plan.'; end if;
    end loop;
end;
$$;

create or replace function public.replace_holdings(p_rows jsonb, p_replace boolean)
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
    v_rate numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    if p_replace then
        update public.holdings
        set is_active = false
        where user_id = v_user_id and is_active = true;
    end if;

    for v_row in select value from jsonb_array_elements(p_rows)
    loop
        v_category_id := (v_row->>'category_id')::uuid;
        if not exists (
            select 1 from public.asset_categories
            where id = v_category_id and user_id = v_user_id
        ) then raise exception 'Invalid category.'; end if;

        v_currency := upper(coalesce(v_row->>'currency', 'INR'));
        v_rate := case when v_currency = 'INR' then 1 else (v_row->>'exchange_rate_to_inr')::numeric end;

        insert into public.holdings (
            user_id, category_id, name, asset_type, currency, current_value,
            exchange_rate_to_inr, notes, is_active, last_updated_at
        ) values (
            v_user_id, v_category_id, v_row->>'name', coalesce(v_row->>'asset_type', 'Other'),
            v_currency, (v_row->>'current_value')::numeric, v_rate,
            nullif(v_row->>'notes', ''), coalesce((v_row->>'is_active')::boolean, true),
            coalesce(nullif(v_row->>'last_updated_at', '')::date, current_date)
        );
    end loop;
end;
$$;

create or replace function public.replace_sip_plans(p_rows jsonb, p_replace boolean)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
    v_category_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    if p_replace then
        update public.sip_plans set is_active = false
        where user_id = v_user_id and is_active = true;
    end if;

    for v_row in select value from jsonb_array_elements(p_rows)
    loop
        v_category_id := (v_row->>'category_id')::uuid;
        if not exists (
            select 1 from public.asset_categories
            where id = v_category_id and user_id = v_user_id
        ) then raise exception 'Invalid category.'; end if;

        insert into public.sip_plans (
            user_id, category_id, name, monthly_amount, sip_day, notes, is_active
        ) values (
            v_user_id, v_category_id, v_row->>'name', (v_row->>'monthly_amount')::numeric,
            nullif(v_row->>'sip_day', '')::integer, nullif(v_row->>'notes', ''),
            coalesce((v_row->>'is_active')::boolean, true)
        );
    end loop;
end;
$$;

create or replace function public.replace_targets(p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_total numeric;
    v_unique_count integer;
    v_category_count integer;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    select coalesce(sum((value->>'target_percentage')::numeric), 0),
           count(distinct value->>'category_id')
    into v_total, v_unique_count
    from jsonb_array_elements(p_rows);

    select count(*) into v_category_count
    from public.asset_categories where user_id = v_user_id;

    if abs(v_total - 100) > 0.01 then raise exception 'Targets must total 100%%.'; end if;
    if v_unique_count <> jsonb_array_length(p_rows) then raise exception 'Duplicate categories are not allowed.'; end if;
    if v_unique_count <> v_category_count then raise exception 'Every category must be included.'; end if;

    delete from public.portfolio_targets where user_id = v_user_id;

    insert into public.portfolio_targets(user_id, category_id, target_percentage)
    select v_user_id, (value->>'category_id')::uuid, (value->>'target_percentage')::numeric
    from jsonb_array_elements(p_rows)
    where exists (
        select 1 from public.asset_categories c
        where c.id = (value->>'category_id')::uuid and c.user_id = v_user_id
    );

    if (select count(*) from public.portfolio_targets where user_id = v_user_id) <> v_category_count then
        raise exception 'One or more categories are invalid.';
    end if;
end;
$$;

create or replace function public.add_asset_category(
    p_name text,
    p_sort_order integer,
    p_target_percentage numeric,
    p_tracking_currency text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_category_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if trim(p_name) = '' then raise exception 'Category name is required.'; end if;
    if p_tracking_currency not in ('INR', 'USD') then raise exception 'Invalid tracking currency.'; end if;

    insert into public.asset_categories(user_id, name, sort_order, tracking_currency)
    values (v_user_id, trim(p_name), p_sort_order, p_tracking_currency)
    returning id into v_category_id;

    insert into public.portfolio_targets(user_id, category_id, target_percentage)
    values (v_user_id, v_category_id, p_target_percentage);

    return v_category_id;
end;
$$;

create or replace function public.delete_asset_category(p_category_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if not exists (
        select 1 from public.asset_categories where id = p_category_id and user_id = v_user_id
    ) then raise exception 'Invalid category.'; end if;

    if exists (select 1 from public.holdings where user_id = v_user_id and category_id = p_category_id)
       or exists (select 1 from public.sip_plans where user_id = v_user_id and category_id = p_category_id)
       or exists (select 1 from public.monthly_category_performance where user_id = v_user_id and category_id = p_category_id)
    then raise exception 'Move or permanently delete all linked records before deleting this category.';
    end if;

    delete from public.portfolio_targets where user_id = v_user_id and category_id = p_category_id;
    delete from public.asset_categories where user_id = v_user_id and id = p_category_id;
end;
$$;

create or replace function public.update_asset_category(
    p_category_id uuid,
    p_name text,
    p_sort_order integer,
    p_tracking_currency text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_existing_currency text;
begin
    select tracking_currency into v_existing_currency
    from public.asset_categories
    where id = p_category_id and user_id = v_user_id
    for update;
    if not found then raise exception 'Invalid category'; end if;
    if trim(p_name) = '' then raise exception 'Category name is required'; end if;
    if p_tracking_currency not in ('INR', 'USD') then raise exception 'Invalid tracking currency'; end if;
    if p_tracking_currency <> v_existing_currency and exists (
        select 1 from public.monthly_category_performance
        where user_id = v_user_id and category_id = p_category_id
    ) then raise exception 'Tracking currency cannot change after monthly performance history exists.'; end if;

    update public.asset_categories
    set name = trim(p_name), sort_order = p_sort_order, tracking_currency = p_tracking_currency
    where id = p_category_id and user_id = v_user_id;
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
    v_month date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
    v_snapshot_id uuid;
    v_note public.investment_notes%rowtype;
    v_total_value numeric;
    v_total_sip numeric;
    v_contribution numeric;
    v_market_gain numeric;
    v_currency_gain numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if exists (
        select 1 from public.portfolio_snapshots
        where user_id = v_user_id and snapshot_month = v_month
    ) then raise exception 'A snapshot already exists for this month.'; end if;

    select * into v_note
    from public.investment_notes
    where user_id = v_user_id and is_current = true
    limit 1;

    select coalesce(sum(coalesce(performance.closing_value_inr, holdings.amount_inr, 0)), 0)
    into v_total_value
    from public.asset_categories category
    left join public.monthly_category_performance performance
        on performance.category_id = category.id
       and performance.user_id = v_user_id
       and performance.performance_month = v_month
    left join (
        select category_id, sum(current_value_inr) amount_inr
        from public.holdings
        where user_id = v_user_id and is_active = true
        group by category_id
    ) holdings on holdings.category_id = category.id
    where category.user_id = v_user_id;

    select coalesce(sum(monthly_amount), 0) into v_total_sip
    from public.sip_plans where user_id = v_user_id and is_active = true;

    select coalesce(sum(contribution_inr), 0),
           coalesce(sum(market_gain_inr), 0),
           coalesce(sum(currency_gain_inr), 0)
    into v_contribution, v_market_gain, v_currency_gain
    from public.monthly_category_performance
    where user_id = v_user_id and performance_month = v_month;

    insert into public.portfolio_snapshots(
        user_id, snapshot_month, total_value_inr, total_monthly_sip,
        note_id, note_title, note_content, total_contribution_inr,
        market_gain_inr, currency_gain_inr, combined_gain_inr
    ) values (
        v_user_id, v_month, v_total_value, v_total_sip,
        v_note.id, v_note.title, v_note.content, v_contribution,
        v_market_gain, v_currency_gain, v_market_gain + v_currency_gain
    ) returning id into v_snapshot_id;

    insert into public.snapshot_categories(
        user_id, snapshot_id, category_id, category_name, amount_inr,
        current_percentage, target_percentage, difference_percentage
    )
    select v_user_id,
           v_snapshot_id,
           category.id,
           category.name,
           coalesce(performance.closing_value_inr, amounts.amount_inr, 0),
           case when v_total_value > 0 then coalesce(performance.closing_value_inr, amounts.amount_inr, 0) / v_total_value * 100 else 0 end,
           coalesce(target.target_percentage, 0),
           case when v_total_value > 0 then coalesce(performance.closing_value_inr, amounts.amount_inr, 0) / v_total_value * 100 else 0 end
             - coalesce(target.target_percentage, 0)
    from public.asset_categories category
    left join (
        select category_id, sum(current_value_inr) amount_inr
        from public.holdings
        where user_id = v_user_id and is_active = true
        group by category_id
    ) amounts on amounts.category_id = category.id
    left join public.monthly_category_performance performance
        on performance.category_id = category.id
       and performance.user_id = v_user_id
       and performance.performance_month = v_month
    left join public.portfolio_targets target
        on target.category_id = category.id and target.user_id = v_user_id
    where category.user_id = v_user_id;

    insert into public.snapshot_sips(
        user_id, snapshot_id, category_id, category_name, name, monthly_amount
    )
    select v_user_id, v_snapshot_id, sip.category_id, category.name, sip.name, sip.monthly_amount
    from public.sip_plans sip
    join public.asset_categories category on category.id = sip.category_id
    where sip.user_id = v_user_id and sip.is_active = true;

    return v_snapshot_id;
end;
$$;

grant select, insert, update, delete on public.monthly_category_performance to authenticated;
grant execute on function public.save_monthly_category_performance(date, jsonb) to authenticated;
grant execute on function public.bulk_update_holdings(jsonb, date) to authenticated;
grant execute on function public.bulk_update_sip_plans(jsonb) to authenticated;
grant execute on function public.replace_holdings(jsonb, boolean) to authenticated;
grant execute on function public.replace_sip_plans(jsonb, boolean) to authenticated;
grant execute on function public.replace_targets(jsonb) to authenticated;
grant execute on function public.add_asset_category(text, integer, numeric, text) to authenticated;
grant execute on function public.delete_asset_category(uuid) to authenticated;
grant execute on function public.update_asset_category(uuid, text, integer, text) to authenticated;
grant execute on function public.create_current_month_snapshot() to authenticated;

-- Keep the single-current-note rule intact even when editing or deleting the current note.
create or replace function public.save_investment_note(
    p_note_id uuid,
    p_title text,
    p_content text,
    p_make_current boolean
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_note_id uuid;
    v_is_current boolean;
begin
    if v_user_id is null then raise exception 'Not authenticated'; end if;

    if p_note_id is not null then
        select is_current into v_is_current
        from public.investment_notes
        where id = p_note_id and user_id = v_user_id
        for update;
        if not found then raise exception 'Invalid note'; end if;
    else
        v_is_current := not exists (
            select 1 from public.investment_notes where user_id = v_user_id
        );
    end if;

    v_is_current := coalesce(p_make_current, false) or coalesce(v_is_current, false);
    if v_is_current then
        update public.investment_notes
        set is_current = false
        where user_id = v_user_id and is_current = true;
    end if;

    if p_note_id is null then
        insert into public.investment_notes(user_id, title, content, is_current)
        values (v_user_id, p_title, p_content, v_is_current)
        returning id into v_note_id;
    else
        update public.investment_notes
        set title = p_title, content = p_content, is_current = v_is_current
        where id = p_note_id and user_id = v_user_id
        returning id into v_note_id;
    end if;

    return v_note_id;
end;
$$;

create or replace function public.set_current_investment_note(p_note_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if not exists (
        select 1 from public.investment_notes where id = p_note_id and user_id = v_user_id
    ) then raise exception 'Invalid note'; end if;
    update public.investment_notes set is_current = false where user_id = v_user_id and is_current = true;
    update public.investment_notes set is_current = true where id = p_note_id and user_id = v_user_id;
end;
$$;

create or replace function public.delete_investment_note(p_note_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_was_current boolean;
    v_replacement_id uuid;
begin
    select is_current into v_was_current
    from public.investment_notes
    where id = p_note_id and user_id = v_user_id
    for update;
    if not found then raise exception 'Invalid note'; end if;

    delete from public.investment_notes where id = p_note_id and user_id = v_user_id;

    if v_was_current then
        select id into v_replacement_id
        from public.investment_notes
        where user_id = v_user_id
        order by updated_at desc nulls last, created_at desc
        limit 1;
        if v_replacement_id is not null then
            update public.investment_notes set is_current = true where id = v_replacement_id;
        end if;
    end if;
end;
$$;

grant execute on function public.save_investment_note(uuid, text, text, boolean) to authenticated;
grant execute on function public.set_current_investment_note(uuid) to authenticated;
grant execute on function public.delete_investment_note(uuid) to authenticated;

-- Complete, account-scoped, all-or-nothing restore for the JSON backup endpoint.
create or replace function public.restore_portfolio_backup(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_data jsonb := p_backup->'data';
    v_row jsonb;
    v_profile jsonb;
begin
    if v_user_id is null then raise exception 'Not authenticated'; end if;
    if p_backup->>'format' <> 'investment-tracker-backup' or (p_backup->>'version')::integer <> 1 then
        raise exception 'Unsupported backup format';
    end if;
    if jsonb_typeof(v_data) <> 'object' then raise exception 'Backup data is missing'; end if;

    -- Lock the account's categories so two restore operations cannot interleave.
    perform 1 from public.asset_categories where user_id = v_user_id for update;

    delete from public.snapshot_sips where user_id = v_user_id;
    delete from public.snapshot_categories where user_id = v_user_id;
    delete from public.portfolio_snapshots where user_id = v_user_id;
    delete from public.monthly_category_performance where user_id = v_user_id;
    delete from public.holdings where user_id = v_user_id;
    delete from public.sip_plans where user_id = v_user_id;
    delete from public.portfolio_targets where user_id = v_user_id;
    delete from public.investment_notes where user_id = v_user_id;
    delete from public.asset_categories where user_id = v_user_id;

    v_profile := coalesce(v_data->'profiles'->0, '{}'::jsonb);
    update public.profiles set
        display_name = nullif(v_profile->>'display_name', ''),
        base_currency = coalesce(nullif(v_profile->>'base_currency', ''), 'INR'),
        default_usd_inr_rate = coalesce((v_profile->>'default_usd_inr_rate')::numeric, 1)
    where user_id = v_user_id;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'asset_categories', '[]'::jsonb)) loop
        insert into public.asset_categories(id, user_id, name, sort_order, tracking_currency)
        values ((v_row->>'id')::uuid, v_user_id, v_row->>'name', coalesce((v_row->>'sort_order')::integer, 99), coalesce(v_row->>'tracking_currency', 'INR'));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'portfolio_targets', '[]'::jsonb)) loop
        insert into public.portfolio_targets(user_id, category_id, target_percentage)
        values (v_user_id, (v_row->>'category_id')::uuid, coalesce((v_row->>'target_percentage')::numeric, 0));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'holdings', '[]'::jsonb)) loop
        insert into public.holdings(id, user_id, category_id, name, asset_type, currency, current_value, exchange_rate_to_inr, notes, is_active, last_updated_at)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'category_id')::uuid, v_row->>'name', coalesce(v_row->>'asset_type', 'Other'),
            coalesce(v_row->>'currency', 'INR'), coalesce((v_row->>'current_value')::numeric, 0),
            case when coalesce(v_row->>'currency', 'INR') = 'INR' then 1 else coalesce((v_row->>'exchange_rate_to_inr')::numeric, 1) end,
            nullif(v_row->>'notes', ''), coalesce((v_row->>'is_active')::boolean, true), coalesce(nullif(v_row->>'last_updated_at', '')::date, current_date));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'sip_plans', '[]'::jsonb)) loop
        insert into public.sip_plans(id, user_id, category_id, name, monthly_amount, sip_day, notes, is_active)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'category_id')::uuid, v_row->>'name', coalesce((v_row->>'monthly_amount')::numeric, 0),
            nullif(v_row->>'sip_day', '')::integer, nullif(v_row->>'notes', ''), coalesce((v_row->>'is_active')::boolean, true));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'investment_notes', '[]'::jsonb)) loop
        insert into public.investment_notes(id, user_id, title, content, is_current)
        values ((v_row->>'id')::uuid, v_user_id, v_row->>'title', coalesce(v_row->>'content', ''), coalesce((v_row->>'is_current')::boolean, false));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'portfolio_snapshots', '[]'::jsonb)) loop
        insert into public.portfolio_snapshots(id, user_id, snapshot_month, total_value_inr, total_monthly_sip, note_title, note_content,
            total_contribution_inr, market_gain_inr, currency_gain_inr, combined_gain_inr)
        values ((v_row->>'id')::uuid, v_user_id, (v_row->>'snapshot_month')::date, coalesce((v_row->>'total_value_inr')::numeric, 0),
            coalesce((v_row->>'total_monthly_sip')::numeric, 0), nullif(v_row->>'note_title', ''), nullif(v_row->>'note_content', ''),
            coalesce((v_row->>'total_contribution_inr')::numeric, 0), coalesce((v_row->>'market_gain_inr')::numeric, 0),
            coalesce((v_row->>'currency_gain_inr')::numeric, 0), coalesce((v_row->>'combined_gain_inr')::numeric, 0));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'snapshot_categories', '[]'::jsonb)) loop
        insert into public.snapshot_categories(user_id, snapshot_id, category_id, category_name, amount_inr, current_percentage, target_percentage, difference_percentage)
        values (v_user_id, (v_row->>'snapshot_id')::uuid, (v_row->>'category_id')::uuid, v_row->>'category_name', coalesce((v_row->>'amount_inr')::numeric, 0),
            coalesce((v_row->>'current_percentage')::numeric, 0), coalesce((v_row->>'target_percentage')::numeric, 0), coalesce((v_row->>'difference_percentage')::numeric, 0));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'snapshot_sips', '[]'::jsonb)) loop
        insert into public.snapshot_sips(user_id, snapshot_id, category_id, category_name, name, monthly_amount)
        values (v_user_id, (v_row->>'snapshot_id')::uuid, (v_row->>'category_id')::uuid, v_row->>'category_name', v_row->>'name', coalesce((v_row->>'monthly_amount')::numeric, 0));
    end loop;

    for v_row in select value from jsonb_array_elements(coalesce(v_data->'monthly_category_performance', '[]'::jsonb)) loop
        insert into public.monthly_category_performance(user_id, category_id, performance_month, tracking_currency, is_baseline,
            opening_native_value, opening_fx_rate, contribution_inr, contribution_native, contribution_fx_rate, closing_native_value,
            closing_fx_rate, opening_value_inr, closing_value_inr, market_gain_native, market_gain_inr, currency_gain_inr, combined_gain_inr)
        values (v_user_id, (v_row->>'category_id')::uuid, (v_row->>'performance_month')::date, v_row->>'tracking_currency',
            coalesce((v_row->>'is_baseline')::boolean, false), coalesce((v_row->>'opening_native_value')::numeric, 0),
            coalesce((v_row->>'opening_fx_rate')::numeric, 1), coalesce((v_row->>'contribution_inr')::numeric, 0),
            coalesce((v_row->>'contribution_native')::numeric, 0), coalesce((v_row->>'contribution_fx_rate')::numeric, 1),
            coalesce((v_row->>'closing_native_value')::numeric, 0), coalesce((v_row->>'closing_fx_rate')::numeric, 1),
            coalesce((v_row->>'opening_value_inr')::numeric, 0), coalesce((v_row->>'closing_value_inr')::numeric, 0),
            coalesce((v_row->>'market_gain_native')::numeric, 0), coalesce((v_row->>'market_gain_inr')::numeric, 0),
            coalesce((v_row->>'currency_gain_inr')::numeric, 0), coalesce((v_row->>'combined_gain_inr')::numeric, 0));
    end loop;
end;
$$;

grant execute on function public.restore_portfolio_backup(jsonb) to authenticated;

commit;
