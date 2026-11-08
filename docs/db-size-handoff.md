# The Brief — Supabase database size: investigation handoff

Written 2026-11-08 from a cloud Claude Code session. Everything below was measured against the live
project (`NewsAgent`, ref `xmgylwzcrjjsaffwnddt`, Postgres 17, pgvector 0.8.2) on 2026-11-07, or read from
the three live routine prompts and the Supabase API logs. Nothing has been applied to the database.
A draft migration exists on branch `claude/hopeful-allen-7u3gfy` (draft PR wbhudson2/the-brief-fetch#1).

## 1. The problem in numbers

Free plan: database goes read-only at 500 MB (database size, not disk). `pg_database_size` = **679 MB**.

| Table | Total | Heap | Indexes | TOAST | Rows |
|---|---|---|---|---|---|
| `memory_embeddings` | 553 MB | 6.5 MB | 325 MB (HNSW 323) | 221 MB | 41,323 |
| `signals` | 99 MB | 37 MB | 11 MB | 51 MB (bodies) | 39,139 |
| everything else (curated memory + catalogs) | ~27 MB | | | | |

Two root causes:

1. **HNSW page padding.** `vector(1024)` float32 = 4,104 bytes. One element fills an 8 KB index page alone:
   338,837,504 bytes / 8,192 = 41,362 pages for 41,323 rows. About half the index is empty space.
2. **Unbounded pool.** 95% of vectors (39,139) are `kind='signal'`, one per fetched article. Signals arrive at
   ~1,400/day (~9,800/week), never deleted; vectors were added since 2026-10-20. Growth ≈ **135 MB/week**.

Per-row cost measured: `memory_embeddings` ≈ 13.7 KB/row today; a 4,000-row probe copied to
`halfvec(1024)` with an HNSW index cost **5.8 KB/row** (heap 1 MB, TOAST 11 MB, HNSW 10 MB for 4,000 rows;
three elements per page). `signals` ≈ 2.5 KB/row (0.95 inline + 0.28 index + 1.3 body).

Curated memory vectors (observation 527, event 874, fact 487, storyline 267, erratum 15, insight 14 =
2,184 rows) grow ~90 rows/day ≈ 15 MB/month at halfvec.

## 2. Who reads the pool and vectors (from the prompts and logs)

| Consumer | Reads | Window |
|---|---|---|
| **Morning Edition** (cron `0 11 * * *`, ~11:07 UTC) | Call D: `signals where fetched_at > now() - interval '30 hours' and used_on is null` (title, abstract, url, storyline_hint, source weight, limit 90); `select body from signals where id = <id>` one at a time; marks `used_on/used_as` (item/thread/radar). Step 8 novelty check: bare `mcp__local-worker__recall` (k 12, no kinds) + `dossier_timeline` + `search_memory` (no signals). Trajectory reads observations/calls for one storyline, any age. `helper_runs` last 3, `helper_health`. | 30 h; recall any age |
| **Weekly Digest** (`9 13 * * 0`) | Call G: `signals ... fetched_at > now() - interval '7 days'` counts by beat; high-weight (src.weight ≥ 7) unused signals limit 40; Step 7 per-beat lists over 7 days; `call_evidence` 8 days; `recall` for Slow-trend "since" checks and call premises. | 7 days |
| **Curator** (`0 1 * * *`) | **No signal reads** (830 distinct nightly queries since 10-16; 2 touched signals, both stats). Vectors: `insight_matches('observation', id, 6, 0.55)` on observations ≤ 3 days; Sunday pattern pass `recall_neighbours('observation', id, 8, 0.70)` over observations ≤ 60 days, keeping only observation/event/fact neighbours; `recall` with `kinds ["insight"]` and bare. Builds dossiers from web research, not the pool. | memory kinds only |
| **Regime script** (`python-requests/2.34.2`, home IP, Georgetown; runs 00:02 and 12:02 UTC) | `GET /rest/v1/signals?select=source_id,outlet,title,url,published_at,fetched_at,abstract,beat_hint&published_at=gte.<now-30d>&order=published_at.desc&limit=1000&offset=N`, ~38 pages/run. No bodies, no vectors, no writes. Uses the anon policy `signals_read_anon` (migration `signals_read_for_regime`, 2026-10-21). Code lives on the helper box; repo on the NAS Gitea. **Not read yet.** | 30 days by `published_at` |
| **Helper** (pop-os; `TheBrief-intake/0.1`) | fetch job every ~3 h: `GET signals?select=url&fetched_at=gte.<now-10d>` for de-dup, `POST signals?on_conflict=url`. Embed job 8–11×/day: pages **all** of `memory_embeddings` (kind, ref, text_hash) and **all** of `memory_embedding_queue` in 1,000-row pages (~41 pages each), then `POST memory_embeddings?on_conflict=kind,ref` (mean 757 ms/statement; one run hit the 60 s `statement_timeout`). Weekly job: evidence + hygiene (storylines dormant, connections deactivated). Watcher writes `helper_health` every 5 min. | 10 days; whole table |
| Evening Edition | disabled since 2026-09-09 | – |

Facts that bound the retention design:

- `used_on` lags `fetched_at` by at most 1 day (max over 704 used rows). Only ~2% of signals are ever used.
- No table holds a foreign key **to** `signals`. `observations/dossier_events/dossier_facts/errata.sources`
  are jsonb arrays of `{outlet,url,date}` or `{outlet:"the-brief",observation_id:N}`; no signal ids.
- Curator pool-sourced citations (events 133, facts 109 in-pool URLs): 85% also cited by an observation
  (came via the daily); the 37 it found itself were ≤ 14 days old (2 over 7 days). Event `recorded_on -
  on_date`: median 3 d, p90 9 d, 8 of 238 over 14 d.
- Recall from 12 fresh signal anchors (k 12, min_sim 0.3): 134 signal hits; 51% ≤ 7 d, 25% 8–14 d,
  15% 15–21 d, 10% ≥ 22 d (pool only 26 days old). Avg sim 0.64 (≤ 7 d) vs 0.52 (older).
- Signals used or cited anywhere: 733 (704 used, 29 cited-only), ~28/day, ~4.6 MB of rows+bodies.
- Egress estimate (free quota 5 GB/month): embed job ~17 MB/run × 8–11 runs/day ≈ 5.6 GB/month;
  regime ~27 MB/run × 2/day ≈ 1.6 GB/month. Unverified; check the org usage page.

## 3. Schema facts the implementation depends on

- `memory_embeddings(kind text check in (observation,storyline,event,fact,erratum,insight,signal), ref text,
  text_hash text, embedding vector(1024), model text, embedded_at)`, PK `(kind, ref)`, index
  `memory_embeddings_hnsw` (`hnsw (embedding vector_cosine_ops)`, no options), `memory_embeddings_kind_idx`.
  RLS on, no policies (service_role only). Model `qwen3-embedding-0.6b-q8`, 1024-d everywhere.
- `memory_embedding_queue` view: union of (kind, ref, text) over all seven kinds; signal text = `title || '\n' || abstract`
  (bodies are **not** embedded). The helper diffs it against stored `(kind, ref, text_hash)`.
- Functions (all `language sql stable`): `recall_by_vector(q vector(1024), kinds text[] default null, k int default 15,
  min_sim real default 0)` (inner `limit greatest(k*3,30)`, builds snippets per kind, `signal` snippet = outlet/title/abstract);
  `recall_neighbours(src_kind, src_ref, k default 10, min_sim default 0.75)`; `insight_matches(src_kind, src_ref, k default 6,
  min_sim default 0.55)`; `search_memory(q, lim)` (full text, no signals); `dossier_state`, `dossier_timeline`.
  Selective `kinds` filters (e.g. `['insight']`) use the btree + exact sort, so filtered recall is not starved.
- Casts: `vector → halfvec` **implicit**; `halfvec → vector` **assignment only** (explicit cast needed in
  function arguments). `halfvec_cosine_ops` exists for hnsw. PostgREST inserts type the column from the
  table, and would still work mid-reload thanks to the implicit cast.
- `cron.schedule(job_name, schedule, command)` exists (pg_cron 1.6.4); one job today: `helper-watchdog` every 10 min.
- New functions in `public` get EXECUTE for `anon` and `authenticated` by default (Supabase default privileges):
  revoke on anything destructive. `signals` has `signals_read_anon for select to anon`.
- `service_role` has `statement_timeout = 60s` (migration 2026-11-07). `shared_buffers` 224 MB.
- `signals_canonical_hash_idx` (2 MB) and three small indexes are unused per the performance advisor; 17 FKs unindexed (irrelevant).
- Exact scan without HNSW: 17.7 s over 41k float32 vectors (detoast-bound). HNSW query: ~1.3 s cold. Keep an index.

## 4. Options evaluated

| Option | Verdict |
|---|---|
| **A. Prune in place + halfvec** (drafted) | Quality-neutral for every reader in §2 at the windows below. ~310 MB steady, +22 MB/month (~9 months runway). No prompt/helper change. 14-day detail window instead → ~250 MB. |
| B. Second free Supabase project for the pool | 2 free projects allowed, 500 MB each, pause after 7 idle days. `recall` spans both tables, three prompts + helper + regime need re-pointing, FK `signals.storyline_hint` must go; pool still fills a project in ~7 weeks without pruning. Not worth it. |
| C. Pool local (helper box / NAS Postgres+pgvector), memory stays in Supabase | Cleanest long-term split. `recall` already runs on the box (embeds query locally, calls `recall_by_vector`); it would search local vectors + Supabase memory vectors. Embed job writes locally (no 757 ms inserts). Regime reads locally. Needs 2–3 new local-worker tools (pool read, `used_on` marks), prompt edits: Morning Call D + Step 12 marks, Weekly Call G + Step 7. Availability tied to the box (daily already falls back to search-only on `Pool: EMPTY/STALE`). |
| D. Everything local | No: cloud routines write the memory through the Supabase MCP; replacing hundreds of SQL lines with tools and depending on home uptime risks the product. |
| E. Pro plan ($25/mo, 8 GB) | ~14 months at current growth; still do halfvec + retention. |
| Later lever | 512-dim vectors (Qwen3-Embedding supports MRL; `l2_normalize(subvector(embedding,1,512))` in SQL) halves every vector figure again but the helper must truncate its output and `recall` its query. |

## 5. The drafted migration (branch `claude/hopeful-allen-7u3gfy`)

File: `supabase/migrations/20261107213000_signals_retention_halfvec.sql` (README section "Database housekeeping" added).

1. `cited_source_urls` view (security_invoker): distinct `sources[*].url` from observations, dossier_events,
   dossier_facts, errata. `signals_prunable(before timestamptz)`: signals fetched before `before`, `used_on is null`,
   URL not cited.
2. `signals_retention(keep_rows interval default '35 days', keep_detail interval default '21 days')`:
   delete `memory_embeddings` (kind signal) for prunable-before-`keep_detail`; null their `body`; delete prunable
   rows before `keep_rows`; delete orphan signal vectors. Returns jsonb counts. EXECUTE revoked from public/anon/authenticated.
   `cron.schedule('signals-retention', '40 9 * * *', ...)`; then runs once.
3. `memory_embedding_queue` re-created with the signal branch filtered to `fetched_at >= now() - interval '21 days'
   or used_on is not null or url in (select url from cited_source_urls)` — **the literal must match `keep_detail`**
   or the helper re-embeds pruned signals.
4. `set local maintenance_work_mem = '128MB'`; drop `memory_embeddings_hnsw`; `alter column embedding type
   halfvec(1024) using embedding::halfvec(1024)` (rewrite compacts heap+TOAST); recreate HNSW with
   `halfvec_cosine_ops`; `recall_by_vector` keeps `q vector(1024)` and compares `m.embedding <=> q::halfvec(1024)`;
   `recall_neighbours`/`insight_matches` pass `m.embedding::vector(1024)`. `notify pgrst, 'reload schema'`.
5. Afterwards, outside the transaction: `vacuum (full, analyze) public.signals; analyze public.memory_embeddings;`

Projected steady state (halfvec, 1,400 signals/day): rows 35 d ≈ 61 MB, bodies 21 d ≈ 38 MB, signal vectors
21 d ≈ 170 MB, memory vectors 13 MB (+15/month), kept used/cited tier +7 MB/month, rest 27 MB ⇒ **~310 MB**.
Right after applying: ~310 MB (no rows older than 35 d exist yet; ~10k bodies cleared; vectors ~185 MB).

Runbook notes: apply over a direct connection in one transaction (`psql -1 -f` or `supabase db push`; the
remote migration history is not in this repo, so `db push` needs `--include-all` or repair). HNSW rebuild on
~22k halfvec rows takes minutes on the Nano; the helper's embed job fails once if it runs during it and retries
(it runs every 2–3 h). Supabase MCP `apply_migration` risks a timeout on the index build — if used, split into
retention first, then the halfvec part, with `create index` as its own statement.

Dry-run numbers on 2026-11-07 data: 733 kept for good; ~19.9k signals older than 21 d lose vector+body; 0 rows
older than 35 d yet.

## 6. Open questions for the local session

1. **Regime script** (NAS Gitea repo, runs on the helper box): is the 30-day `published_at` lookback a parameter
   or a baseline the regime math needs? Does it ever need bodies or vectors? Any writes anywhere? If 30 days is
   hard, 35-day rows is right; if it needs longer, raise `keep_rows` (rows are cheap: ~1.3 KB each).
2. **Archive before prune?** A helper job could copy pruned signals (rows, bodies, vectors) to local storage so
   nothing is lost; no prompt changes. Decide where (box or NAS) and format.
3. **Windows.** 21/35 was chosen from the observed maxima with margin; 14/35 saves ~60 MB. The Curator's own pool
   finds were ≤ 14 days; the weekly reads 7 days; the daily 30 h.
4. **Helper embed job egress.** It re-reads the whole queue and key list every run; filtering to recent rows
   (e.g. `fetched_at` / `embedded_at` windows) would cut egress ~10× regardless of the DB-size fix.
5. The user has "a much easier way" in mind — evaluate it against §2 before touching the draft.

## 7. Re-measure quickly

```sql
select pg_size_pretty(pg_database_size(current_database()));
select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) total, pg_size_pretty(pg_indexes_size(c.oid)) idx,
       pg_size_pretty(coalesce(pg_total_relation_size(c.reltoastrelid),0)) toast, c.reltuples::bigint rows
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' order by pg_total_relation_size(c.oid) desc limit 8;
select kind, count(*), min(embedded_at)::date, max(embedded_at)::date from memory_embeddings group by kind order by 2 desc;
select date_trunc('week', fetched_at)::date wk, count(*) n, count(used_on) used,
       pg_size_pretty(sum(coalesce(octet_length(body),0))) body from signals group by 1 order by 1;
select query, calls, mean_exec_time from extensions.pg_stat_statements
 where query ilike '%signals%' or query ilike '%memory_embeddings%' order by calls desc limit 30;
```

API logs (Supabase MCP `query_logs`, 24 h window max): `source='edge_logs'`, filter on
`log_attributes['request.path']` and `['request.search']`; the regime reader has `request.headers.user_agent`
starting `python-requests` and an empty `request.sb.jwt.apikey.payload.role`.

## 8. Session state

- Branch `claude/hopeful-allen-7u3gfy`, commits `eb51014` (flat 14-day draft) and `21fa6f2` (tiered 21/35,
  used/cited kept). Draft PR #1 open, mergeable, no CI in the repo, no review comments.
- Database untouched. No Supabase objects created; the halfvec probe used a temp table only.
- Routine prompts (Morning, Weekly, Curator, Evening) were read in full via the scheduled-task list; the regime
  script has not been read.
