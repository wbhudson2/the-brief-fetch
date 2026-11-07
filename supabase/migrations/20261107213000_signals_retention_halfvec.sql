-- Shrink the ledger to fit the Supabase free tier (500 MB) without changing what the brief,
-- the weekly or the Curator can read.
--
-- Measured on 2026-11-07 (pg_database_size 679 MB):
--   memory_embeddings   553 MB   41,323 vector(1024) rows; 39,139 of them (95%) are pool signals.
--                                HNSW index 323 MB: a 4 KB float32 vector fills an 8 KB index page on
--                                its own, so the index is about half padding. TOAST 221 MB for the vectors.
--   signals              99 MB   39,139 articles, ~1,400/day since 2026-10-12, never deleted (bodies 51 MB).
--   everything else     ~27 MB   the curated memory: storylines, observations, dossiers, insights, calls...
--
-- Who reads the pool, from pg_stat_statements (since 2026-10-16) and the API logs:
--   * the daily (11:00 UTC) reads signals from the last ~30 h, including bodies, and marks used_on the
--     same or next day (max lag 1 day);
--   * the weekly (Sunday 13:00 UTC) reads pool counts over the last week;
--   * the Curator (01:00-04:00 UTC) never reads signals directly: 830 distinct nightly queries, two of
--     them pool statistics. It reaches memory_embeddings only through insight_matches and
--     recall_neighbours. Of its pool-sourced citations, 85% arrived via the daily's observations; the
--     ones it found itself were at most 14 days old;
--   * a "regime" reader (anon policy signals_read_anon) pages the whole pool back 30 days by
--     published_at, taking titles, abstracts, outlets and beats, never bodies;
--   * the helper reads memory_embedding_queue, memory_embeddings (kind, ref, text_hash) and signal URLs
--     from the last 10 days to de-duplicate fetches;
--   * nothing holds a foreign key to signals; observation and dossier sources store URLs, not signal ids.
--
-- Three retention tiers on the pool, pruned daily by pg_cron. The curated memory kinds (observation,
-- storyline, event, fact, erratum, insight) are never touched:
--   kept for good   a signal an edition used (used_on) or that any observation, dossier event, dossier
--                   fact or erratum cites by URL: row, body and vector. About 28 a day.
--   21 days         vector and body of every other signal. Of the pool hits recall returns for a fresh
--                   article, 76% are within 14 days and the older ones are the weaker matches; the
--                   Curator's own pool finds were within 14 days. 21 leaves a week of margin.
--   35 days         the row itself (title, abstract, outlet, beat, URL, entities), which is what the
--                   regime reader and pool statistics use. Rows are cheap: ~1.3 KB each.
--
-- Plus: embeddings stored as halfvec(1024) (16-bit floats). Cosine ranking is unchanged to ~3 decimals
-- and three vectors fit an HNSW page instead of one. Measured on 4,000 rows: 5.8 KB/row vs 13.7 KB/row.
--
-- Expected result: ~310 MB steady state (rows 61, bodies 38, signal vectors 170, memory vectors 13,
-- the rest 27), growing ~22 MB/month, of which ~15 is the curated memory. With a 14-day detail window
-- instead: ~250 MB. The next lever, when needed, is 512-dim vectors (Qwen3-Embedding supports it),
-- which halves every vector figure again but needs the helper to truncate its output.
--
-- Apply over a direct connection in one transaction (psql -1 -f, or `supabase db push`): the HNSW rebuild
-- can take a few minutes. The helper's embed job fails once if it runs during the rebuild and retries later.

-- 1. What the pool must keep ----------------------------------------------------------------------------

-- URLs the memory cites. Used by the retention function and by memory_embedding_queue.
create or replace view public.cited_source_urls
with (security_invoker = true) as
  select distinct src->>'url' as url
    from observations o,
         jsonb_array_elements(case when jsonb_typeof(o.sources) = 'array' then o.sources else '[]'::jsonb end) src
   where src->>'url' is not null
  union
  select distinct src->>'url'
    from dossier_events e,
         jsonb_array_elements(case when jsonb_typeof(e.sources) = 'array' then e.sources else '[]'::jsonb end) src
   where src->>'url' is not null
  union
  select distinct src->>'url'
    from dossier_facts f,
         jsonb_array_elements(case when jsonb_typeof(f.sources) = 'array' then f.sources else '[]'::jsonb end) src
   where src->>'url' is not null
  union
  select distinct src->>'url'
    from errata x,
         jsonb_array_elements(case when jsonb_typeof(x.sources) = 'array' then x.sources else '[]'::jsonb end) src
   where src->>'url' is not null;

revoke all on public.cited_source_urls from public, anon, authenticated;
comment on view public.cited_source_urls is
  'Every URL cited in observations, dossier_events, dossier_facts or errata sources. A signal with one of these URLs is kept for good by signals_retention().';

-- Signals fetched before a moment that no edition used and nothing cites: the only ones retention may touch.
create or replace function public.signals_prunable(before timestamptz)
returns setof bigint
language sql stable
set search_path = public
as $$
  select s.id
    from signals s
   where s.fetched_at < before
     and s.used_on is null
     and not exists (select 1 from cited_source_urls c where c.url = s.url)
$$;
revoke execute on function public.signals_prunable(timestamptz) from public, anon, authenticated;

-- 2. Retention ------------------------------------------------------------------------------------------

create or replace function public.signals_retention(keep_rows interval default interval '35 days',
                                                     keep_detail interval default interval '21 days')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  n_emb    integer;
  n_body   integer;
  n_rows   integer;
  n_orphan integer;
begin
  -- Vectors of unused, uncited signals older than keep_detail. memory_embedding_queue stops listing
  -- these signals at the same age (same literal there), so the helper does not embed them again.
  delete from memory_embeddings e
   where e.kind = 'signal'
     and e.ref in (select id::text from signals_prunable(now() - keep_detail));
  get diagnostics n_emb = row_count;

  -- Their bodies. The daily reads a body only for signals it is about to run, within ~30 h of the fetch.
  update signals s
     set body = null
   where s.body is not null
     and s.id in (select signals_prunable(now() - keep_detail));
  get diagnostics n_body = row_count;

  -- The rows themselves, once older than keep_rows.
  delete from signals s
   where s.id in (select signals_prunable(now() - keep_rows));
  get diagnostics n_rows = row_count;

  -- Vectors whose signal is already gone (embedded between a queue read and a prune).
  delete from memory_embeddings e
   where e.kind = 'signal'
     and not exists (select 1 from signals s where s.id::text = e.ref);
  get diagnostics n_orphan = row_count;

  return jsonb_build_object('detail_before', now() - keep_detail, 'rows_before', now() - keep_rows,
                            'embeddings_deleted', n_emb + n_orphan, 'bodies_cleared', n_body,
                            'signals_deleted', n_rows);
end $$;

comment on function public.signals_retention(interval, interval) is
  'Prunes the intake pool. Signals an edition used or the memory cites are kept whole for good. Other signals lose their vector and body after keep_detail (21 days; keep in step with memory_embedding_queue) and their row after keep_rows (35 days; the regime reader looks back 30). Run daily by pg_cron (job signals-retention).';

-- Not callable through PostgREST by the anon or authenticated roles (signals has an anon select policy).
revoke execute on function public.signals_retention(interval, interval) from public, anon, authenticated;

-- The helper's embedding queue: signals only while they are within the detail window or kept for good,
-- so a vector the retention removed is not computed again.
create or replace view public.memory_embedding_queue as
  select 'observation'::text as kind, o.id::text as ref, o.headline || E'\n' || coalesce(o.why_it_matters,'') as text from observations o
  union all
  select 'storyline', s.id, s.title || E'\n' || coalesce(s.market_thesis,'') || E'\n' || right(coalesce(s.running_synthesis,''), 1500) from storylines s
  union all
  select 'event', e.id::text, e.on_date::text || ' ' || e.title || E'\n' || coalesce(e.detail,'') from dossier_events e
  union all
  select 'fact', f.id::text, f.subject || E'\n' || f.claim from dossier_facts f
  union all
  select 'erratum', e.id::text, e.claim || E'\n' || e.correction from errata e
  union all
  select 'insight', i.id, i.title || E'\n' || i.claim || E'\n' || coalesce(i.scope,'') from insights i
  union all
  select 'signal', s.id::text, s.title || E'\n' || coalesce(s.abstract,'') from signals s
   where s.fetched_at >= now() - interval '21 days'
      or s.used_on is not null
      or s.url in (select url from cited_source_urls);

comment on table public.signals is
  'The intake pool: one row per fetched article. The daily reads the last ~30 h first and marks what it ran (used_on/used_as). The helper fills storyline_hint by entity overlap and, from M2, insight_hits from the insights cues. Retention (signals_retention, daily): used or cited signals are kept for good; others lose vector and body after 21 days and the row after 35.';

-- Daily at 09:40 UTC: after the Curator and the helper's overnight runs, before the daily (~11:00 UTC).
-- cron.schedule with an existing job name updates that job.
select cron.schedule('signals-retention', '40 9 * * *', $cron$select public.signals_retention()$cron$);

-- Prune now.
select public.signals_retention();

-- 3. halfvec --------------------------------------------------------------------------------------------

set local maintenance_work_mem = '128MB';

drop index if exists public.memory_embeddings_hnsw;

-- The rewrite also compacts the heap and TOAST after the prune above.
alter table public.memory_embeddings
  alter column embedding type extensions.halfvec(1024)
  using embedding::extensions.halfvec(1024);

create index memory_embeddings_hnsw on public.memory_embeddings
  using hnsw (embedding extensions.halfvec_cosine_ops);

comment on table public.memory_embeddings is
  'One halfvec(1024) per memory row (observation, storyline, dossier event/fact, erratum, insight, pool signal), computed by the helper with Qwen3-Embedding-0.6B. Signal vectors follow the pool''s retention (signals_retention); the other kinds are kept for good. Query with recall_by_vector().';

-- 4. Functions: callers keep sending float32 vectors; the comparison happens in halfvec ------------------

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

-- Afterwards, outside the transaction, to hand the cleared body pages back to the OS and refresh stats:
--   vacuum (full, analyze) public.signals;
--   analyze public.memory_embeddings;
