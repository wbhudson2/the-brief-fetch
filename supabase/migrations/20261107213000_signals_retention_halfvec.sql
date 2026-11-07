-- Shrink the ledger to fit the Supabase free tier (500 MB) without changing what the brief reads.
--
-- Measured on 2026-11-07 (pg_database_size 679 MB):
--   memory_embeddings   553 MB   41,323 vector(1024) rows; 39,139 of them (95%) are pool signals.
--                                HNSW index 323 MB: a 4 KB float32 vector fills an 8 KB index page on
--                                its own, so the index is about half padding. TOAST 221 MB for the vectors.
--   signals              99 MB   39,139 articles, ~1,400/day since 2026-10-12, never deleted (bodies 51 MB).
--   everything else     ~27 MB   the curated memory: storylines, observations, dossiers, insights, calls...
--
-- What reads these two tables (pg_stat_statements since 2026-10-16):
--   * the daily reads signals from the last ~30 h and marks used_on the same or next day (max lag 1 day);
--   * the helper reads recent signals by published_at / fetched_at, and memory_embedding_queue;
--   * recall_by_vector, recall_neighbours and insight_matches search memory_embeddings by meaning;
--   * nothing holds a foreign key to signals; observation and dossier sources store URLs, not signal ids.
--
-- Two changes:
--   1. Retention on the intake pool: keep 14 days of signals and their embeddings, pruned daily by pg_cron.
--      Of the signal hits recall returns for a fresh article, three quarters are within 14 days, and the
--      older ones are the weaker matches. The curated memory kinds are never pruned.
--   2. Store embeddings as halfvec(1024) (16-bit floats). Cosine ranking is unchanged to ~3 decimals and
--      three vectors fit an HNSW page instead of one. Measured on 4,000 rows: 5.8 KB/row vs 13.7 KB/row.
--
-- Expected result: ~250 MB right after, ~200 MB once `vacuum full signals` has run, then growing about
-- 15 MB/month from the curated memory only. Steady state for other windows, all-in:
-- 7 d ≈ 120 MB, 14 d ≈ 200 MB, 21 d ≈ 285 MB, 30 d ≈ 390 MB.
--
-- Apply over a direct connection in one transaction (psql -1 -f, or `supabase db push`): the HNSW rebuild
-- can take a few minutes. The helper's embed job fails once if it runs during the rebuild and retries later.

-- 1. Retention ----------------------------------------------------------------------------------------

create or replace function public.signals_retention(keep interval default interval '14 days')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cutoff   timestamptz := now() - keep;
  n_emb    integer;
  n_orphan integer;
  n_sig    integer;
begin
  -- Vectors of the signals about to go. Same transaction as the signal delete, so the helper's embed
  -- job never sees a signal without a vector and re-embeds it.
  delete from memory_embeddings e
   using signals s
   where e.kind = 'signal' and e.ref = s.id::text and s.fetched_at < cutoff;
  get diagnostics n_emb = row_count;

  delete from signals where fetched_at < cutoff;
  get diagnostics n_sig = row_count;

  -- Vectors whose signal is already gone (embedded between a queue read and a prune).
  delete from memory_embeddings e
   where e.kind = 'signal'
     and not exists (select 1 from signals s where s.id::text = e.ref);
  get diagnostics n_orphan = row_count;

  return jsonb_build_object('cutoff', cutoff, 'signals_deleted', n_sig,
                            'embeddings_deleted', n_emb + n_orphan);
end $$;

comment on function public.signals_retention(interval) is
  'Prunes the intake pool: deletes signals fetched before now() - keep and their memory_embeddings rows. Run daily by pg_cron (job signals-retention). Call with another interval to prune once with a different window; re-schedule the job to change it for good.';

-- Not callable through PostgREST by the anon or authenticated roles (signals has an anon select policy).
revoke execute on function public.signals_retention(interval) from public, anon, authenticated;

-- Daily at 09:40 UTC: after the helper's overnight runs, before the daily edition (~11:00 UTC).
-- cron.schedule with an existing job name updates that job.
select cron.schedule('signals-retention', '40 9 * * *', $cron$select public.signals_retention()$cron$);

-- Prune now.
select public.signals_retention();

-- 2. halfvec ------------------------------------------------------------------------------------------

set local maintenance_work_mem = '128MB';

drop index if exists public.memory_embeddings_hnsw;

-- The rewrite also compacts the heap and TOAST after the prune above.
alter table public.memory_embeddings
  alter column embedding type extensions.halfvec(1024)
  using embedding::extensions.halfvec(1024);

create index memory_embeddings_hnsw on public.memory_embeddings
  using hnsw (embedding extensions.halfvec_cosine_ops);

comment on table public.memory_embeddings is
  'One halfvec(1024) per memory row (observation, storyline, dossier event/fact, erratum, insight, pool signal), computed by the helper with Qwen3-Embedding-0.6B. Signal vectors follow the pool''s 14-day retention (signals_retention). Query with recall_by_vector().';

-- 3. Functions: callers keep sending float32 vectors; the comparison happens in halfvec ----------------

create or replace function public.recall_by_vector(q extensions.vector(1024), kinds text[] default null, k integer default 15, min_sim real default 0.0)
returns table (kind text, ref text, on_date date, snippet text, similarity real)
language sql stable as $$
  with hits as (
    select m.kind, m.ref, 1 - (m.embedding <=> q::extensions.halfvec(1024)) as sim
      from memory_embeddings m
     where (kinds is null or m.kind = any(kinds))
     order by m.embedding <=> q::extensions.halfvec(1024)
     limit greatest(k * 3, 30)
  )
  select h.kind, h.ref,
         case h.kind
           when 'observation' then (select o.run_date from observations o where o.id::text = h.ref)
           when 'storyline'   then (select s.last_updated from storylines s where s.id = h.ref)
           when 'event'       then (select e.on_date from dossier_events e where e.id::text = h.ref)
           when 'fact'        then (select f.valid_from from dossier_facts f where f.id::text = h.ref)
           when 'erratum'     then (select e.edition_date from errata e where e.id::text = h.ref)
           when 'signal'      then (select coalesce(s.published_at, s.fetched_at)::date from signals s where s.id::text = h.ref)
           else null end as on_date,
         case h.kind
           when 'observation' then (select left(o.storyline_id || ' :: ' || o.headline || ' :: ' || coalesce(o.why_it_matters,''), 320) from observations o where o.id::text = h.ref)
           when 'storyline'   then (select left(s.id || ' :: ' || s.title || ' :: ' || coalesce(s.market_thesis,''), 320) from storylines s where s.id = h.ref)
           when 'event'       then (select left(e.dossier_id || ' ' || e.on_date || ' (' || e.confidence || ') ' || e.title, 320) from dossier_events e where e.id::text = h.ref)
           when 'fact'        then (select left(f.dossier_id || '/' || f.subject || case when f.retracted_on is not null then ' RETRACTED ' when f.valid_to is not null then ' until ' || f.valid_to || ': ' else ' CURRENT (' || f.confidence || ') ' end || f.claim, 320) from dossier_facts f where f.id::text = h.ref)
           when 'erratum'     then (select left('WRONG: ' || e.claim || ' :: RIGHT: ' || e.correction, 320) from errata e where e.id::text = h.ref)
           when 'signal'      then (select left(coalesce(s.outlet,'') || ' :: ' || s.title || ' :: ' || coalesce(s.abstract,''), 320) from signals s where s.id::text = h.ref)
           else h.ref end as snippet,
         h.sim::real as similarity
    from hits h
   where h.sim >= min_sim
   order by h.sim desc
   limit k
$$;

-- halfvec -> vector is an assignment cast, not implicit, so the two wrappers cast explicitly.
create or replace function public.recall_neighbours(src_kind text, src_ref text, k integer default 10, min_sim real default 0.75)
returns table (kind text, ref text, on_date date, snippet text, similarity real)
language sql stable as $$
  select r.* from memory_embeddings m, lateral recall_by_vector(m.embedding::extensions.vector(1024), null, k + 1, min_sim) r
   where m.kind = src_kind and m.ref = src_ref and not (r.kind = src_kind and r.ref = src_ref)
   limit k
$$;

create or replace function public.insight_matches(src_kind text, src_ref text, k integer default 6, min_sim real default 0.55)
returns table (insight_id text, status insight_status, similarity real, title text)
language sql stable as $$
  select r.ref as insight_id, i.status, r.similarity, i.title
    from memory_embeddings m
    cross join lateral recall_by_vector(m.embedding::extensions.vector(1024), array['insight'], k, min_sim) r
    join insights i on i.id = r.ref
   where m.kind = src_kind and m.ref = src_ref and i.status <> 'retired'
   order by r.similarity desc
$$;
comment on function public.insight_matches(text, text, integer, real) is
  'The insights nearest to one embedded memory row (an observation, event or fact), for the Curator nightly evidence pass. Needs the row to have been embedded by the helper first; for rows written tonight use the helper recall tool with kinds [insight].';

-- PostgREST re-reads column types (it would still work meanwhile: vector -> halfvec is an implicit cast).
notify pgrst, 'reload schema';

-- Afterwards, outside the transaction, to hand the pruned signal pages back to the OS and refresh stats:
--   vacuum (full, analyze) public.signals;
--   analyze public.memory_embeddings;
