# the-brief-fetch

A small, read-only research tool behind a personal daily news brief. It runs as a
single Supabase Edge Function (Deno) and speaks the Model Context Protocol (MCP) so an
AI research agent can (a) read the text of public web pages, (b) see what is being
discussed on a fixed list of public subreddits, and (c) look up daily market closes.
One person reads the resulting brief. Nothing is published, sold, or used to train
models.

## What it does with Reddit

Read-only, low volume, on the order of 50–100 requests per day in total.

- `reddit_top` / `reddit_scan` — top posts of the day in a subreddit (default list:
  news, politics, environment, technology, technews, economics, economy, science,
  finance, futurology, worldnews, wallstreetbets).
- `reddit_search` — keyword search within a subreddit.
- `reddit_comments` — a post's body and its top-level comments.

Endpoints used (OAuth `client_credentials`, script app, descriptive User-Agent):
`GET /r/{subreddit}/top`, `GET /r/{subreddit}/search`, `GET /r/{subreddit}/comments/{id}`.

What it never does: post, vote, message, follow, collect or store user profiles,
scrape at scale, or redistribute content. Post titles, links and short excerpts are
used to decide what to corroborate against primary news sources; the brief cites
those primary sources.

Without API credentials the tool falls back to Reddit's public Atom feeds, paced to
one request per ~6.5 s and honouring `Retry-After`.

## Other tools

- `fetch_page` — readable text of a public URL (Mozilla Readability), with a
  private-address guard, redirect checks and a size cap.
- `market_history` — daily closes for a ticker from Yahoo Finance's chart endpoint.

## Layout

- `supabase/functions/brief-fetch/index.ts` — the whole server.
- `smoke-test.sh` — raw JSON-RPC checks against a deployment.

## Deploy

```
npx supabase functions deploy brief-fetch --project-ref <ref> --no-verify-jwt
npx supabase secrets set --project-ref <ref> MCP_TOKEN=... REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... REDDIT_USER_AGENT="script:the-brief-fetch:1.0 (by /u/<you>)"
```

Access is guarded by a secret path segment (`/mcp/<MCP_TOKEN>`) because the MCP
client cannot send custom headers; the gateway JWT check is therefore disabled for
this function.

## License

MIT.

## Database housekeeping

The brief's ledger lives in the same Supabase project. Two tables grow without bound and
had pushed the database past the free tier's 500 MB: `signals` (the intake pool, ~1,400
articles a day) and `memory_embeddings` (one vector per pool article). The curated memory
(storylines, observations, dossiers, insights, errata, calls) is small and is never pruned.

`supabase/migrations/20261107213000_signals_retention_halfvec.sql` keeps the database small:

- `signals_retention()`, run daily by a pg_cron job (`signals-retention`, 09:40 UTC), prunes
  the pool in tiers. A signal an edition used or that any observation, dossier event, dossier
  fact or erratum cites is kept whole for good. Every other signal loses its vector and body
  after 21 days (nothing reads them later; the Curator's own pool finds are within 14 days)
  and its row after 35 days (the regime reader looks back 30).
- embeddings are stored as `halfvec(1024)` (16-bit floats), which cuts the HNSW index and
  TOAST to under half; `recall_by_vector()` keeps its `vector(1024)` argument.

Change the windows with
`select cron.schedule('signals-retention', '40 9 * * *', $$select public.signals_retention(interval '45 days', interval '28 days')$$);`
and keep the 21-day literal in `memory_embedding_queue` in step with the second argument.
