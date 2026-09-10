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
