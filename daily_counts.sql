-- 日別の回答数だけを同期する方式への切り替え。SQL Editor に丸ごと貼って実行（何度実行してもOK）。
-- 端末は「日付 → その日に解いた問題数」のJSONだけを送る。回答の中身は送らない。

-- ============ 日別の回答数（ユーザー×日付で1行） ============
create table if not exists public.daily_counts (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,                              -- 日本時間の学習日
  answers    integer not null check (answers between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists daily_counts_day_idx on public.daily_counts (day, user_id);

alter table public.daily_counts enable row level security;
drop policy if exists daily_select_own on public.daily_counts;
create policy daily_select_own on public.daily_counts for select to authenticated using (user_id = auth.uid());
revoke all on public.daily_counts from anon, authenticated, public;
grant select on public.daily_counts to authenticated;   -- 書き込みは下のRPCだけ

-- ============ 同期：{"2026-11-01": 12, "2026-10-31": 5} を受け取る ============
-- 端末は毎回「全日分」を送る。何度送っても同じ結果（冪等）。
-- 件数は減らさない（greatest）ので、古い状態が遅れて届いても巻き戻らない。
-- 不正な日付・件数の行は黙って無視する（1行のせいで全体が止まらない）。
create or replace function public.sync_daily(p_days jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  today date := (now() at time zone 'Asia/Tokyo')::date;
  k     record;
  d     date;
  c     int;
  n     int := 0;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if jsonb_typeof(p_days) <> 'object' then raise exception 'invalid payload' using errcode = '22023'; end if;

  for k in select key, value from jsonb_each_text(p_days) limit 400 loop
    begin
      d := k.key::date;
      c := k.value::int;
      continue when d < today - 400 or d > today + 1 or c < 0 or c > 100000;
      insert into public.daily_counts (user_id, day, answers)
      values (uid, d, c)
      on conflict (user_id, day) do update
         set answers = excluded.answers, updated_at = now()
       where excluded.answers > public.daily_counts.answers;
      n := n + 1;
    exception when others then
      continue;
    end;
  end loop;

  return jsonb_build_object('days', n);
end $$;

-- ============ ランキング（解いた問題数。今日／通算）：daily_counts から集計 ============
create or replace function public.get_ranking()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Tokyo')::date;
  result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  with t as (
    select user_id,
           sum(answers)::int as total,
           (coalesce(sum(answers) filter (where day = today), 0))::int as today_n
    from public.daily_counts group by user_id
  ), me as (
    select coalesce((select total from t where user_id = uid), 0)   as total,
           coalesce((select today_n from t where user_id = uid), 0) as today_n
  )
  select jsonb_build_object(
    'version', 1, 'basis', 'question-counts',
    'day', to_char(today, 'YYYY-MM-DD'),
    'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'daily', jsonb_build_object(
       'answers', me.today_n,
       'participants', (select count(*) from t where today_n > 0),
       'rank', case when me.today_n = 0 then null else 1 + (select count(*) from t where today_n > me.today_n) end,
       'tied', case when me.today_n = 0 then 0 else (select count(*) from t where today_n = me.today_n) end,
       -- 1つ上の人（自分より多い人のうち最少）との差。1位・0問のときは null
       'gap', case when me.today_n = 0 then null else (select min(today_n) from t where today_n > me.today_n) - me.today_n end),
    'allTime', jsonb_build_object(
       'answers', me.total,
       'participants', (select count(*) from t where total > 0),
       'rank', case when me.total = 0 then null else 1 + (select count(*) from t where total > me.total) end,
       'tied', case when me.total = 0 then 0 else (select count(*) from t where total = me.total) end,
       'gap', case when me.total = 0 then null else (select min(total) from t where total > me.total) - me.total end)
  ) into result from me;
  return result;
end $$;

-- ============ 実行権限 ============
revoke all on function public.sync_daily(jsonb) from public, anon;
revoke all on function public.get_ranking()     from public, anon;
grant execute on function public.sync_daily(jsonb) to authenticated;
grant execute on function public.get_ranking()     to authenticated;

-- ============ 旧方式の後片付け ============
-- 回答を1件ずつ送る旧RPCは使わないので閉じる。
drop function if exists public.sync_batch(jsonb, jsonb);
-- 旧テーブル(answers / review_state)も不要なら、下の2行のコメントを外して実行（中身が消えます）。
-- drop table if exists public.answers;
-- drop table if exists public.review_state;
