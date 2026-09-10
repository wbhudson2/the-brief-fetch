// brief-fetch — a tiny MCP server (Streamable HTTP, stateless) that gives The Brief's
// routines a way to read web pages, Reddit and market prices from inside the cloud
// sandbox, whose egress proxy blocks WebFetch. MCP traffic reaches this server via
// Anthropic's MCP proxy, which the sandbox allows.
//
// Auth: the connector URL carries a secret path segment (/mcp/<token>); verify_jwt is
// off at the gateway because claude.ai custom connectors cannot send custom headers.
// Set MCP_TOKEN as a function secret (or substitute the placeholder at deploy time).
//
// Tools: fetch_page, reddit_top, reddit_search, reddit_comments, reddit_scan, market_history.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML, DOMParser } from "npm:linkedom@0.18.12";

const VERSION = "1.0.0";
const TOKEN = Deno.env.get("MCP_TOKEN") ?? "__MCP_TOKEN__";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const REDDIT_UA = Deno.env.get("REDDIT_USER_AGENT") ?? "server:the-brief-fetch:1.0 (news research brief)";
const REDDIT_ID = Deno.env.get("REDDIT_CLIENT_ID") ?? "";
const REDDIT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET") ?? "";
const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 20_000;

// ---------- helpers ----------

function assertPublicUrl(u: URL) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https URLs are allowed");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    throw new Error("host not allowed");
  }
  if (h.includes(":")) throw new Error("IPv6 literals not allowed");
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) {
      throw new Error("private address not allowed");
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Follow redirects manually so every hop passes the public-host check.
async function fetchPublic(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    assertPublicUrl(current);
    const res = await fetchWithTimeout(current.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      await res.body?.cancel();
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function readLimited(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > max) {
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}

function tidy(text: string): string {
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(html: string): string {
  const fallback = () => tidy(html.replace(/<[^>]+>/g, " ").replace(/&#32;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  try {
    const { document } = parseHTML(`<html><head></head><body>${html}</body></html>`);
    const text = (document.body ?? document.documentElement)?.textContent ?? "";
    return text.trim() ? tidy(text) : fallback();
  } catch {
    return fallback();
  }
}

// Reddit's Atom feeds describe link posts as "submitted by u/x [link] [comments]";
// pull the external article URL out of the [link] anchor.
function rssExternalLink(html: string): string | null {
  try {
    const { document } = parseHTML(`<html><head></head><body>${html}</body></html>`);
    for (const a of document.querySelectorAll("a")) {
      if ((a.textContent ?? "").trim() === "[link]") {
        const href = a.getAttribute("href") ?? "";
        if (href && !/reddit\.com\/r\/[^/]+\/comments\//.test(href)) return href;
      }
    }
  } catch { /* ignore */ }
  const m = html.match(/href="([^"]+)"[^>]*>\s*\[link\]/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function isoFromUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

function extractArticle(html: string) {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") ?? null;
  const published =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="article:published_time"]') ??
    meta('meta[name="pubdate"]') ??
    meta('meta[name="publishdate"]') ??
    meta('meta[name="date"]') ??
    meta('meta[property="og:updated_time"]') ??
    document.querySelector("time[datetime]")?.getAttribute("datetime") ??
    null;
  const site = meta('meta[property="og:site_name"]');
  let title = document.querySelector("title")?.textContent?.trim() ?? null;
  let byline: string | null = null;
  let text = "";
  try {
    const r = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    if (r && r.textContent) {
      text = r.textContent;
      title = r.title || title;
      byline = r.byline ?? null;
    }
  } catch { /* fall through to plain strip */ }
  if (!text.trim()) {
    const { document: d2 } = parseHTML(html);
    for (const el of d2.querySelectorAll("script,style,noscript,svg,iframe")) el.remove();
    text = d2.body?.textContent ?? "";
  }
  return { title, byline, published, site, text: tidy(text) };
}

// ---------- tool: fetch_page ----------

async function fetchPage(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const maxChars = Math.min(Math.max(Number(args.max_chars ?? 12000), 500), 60000);
  const raw = Boolean(args.raw ?? false);
  const res = await fetchPublic(url, {
    headers: {
      "user-agent": BROWSER_UA,
      "accept": "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  const { text: body, truncated: bodyTruncated } = await readLimited(res, MAX_HTML_BYTES);
  if (res.status >= 400) {
    return `HTTP ${res.status} for ${res.url || url}\n${clip(stripHtml(body), 500)}`;
  }
  const header: string[] = [];
  let out = "";
  if (ctype.includes("json")) {
    try { out = JSON.stringify(JSON.parse(body), null, 1); } catch { out = body; }
    header.push(`TYPE: json`);
  } else if (ctype.includes("text/plain") || ctype.includes("xml") || raw) {
    out = raw ? body : tidy(body);
    header.push(`TYPE: ${raw ? "raw" : "text"}`);
  } else {
    const a = extractArticle(body);
    if (a.title) header.push(`TITLE: ${a.title}`);
    if (a.byline) header.push(`BYLINE: ${a.byline}`);
    if (a.published) header.push(`PUBLISHED: ${a.published}`);
    if (a.site) header.push(`SITE: ${a.site}`);
    out = a.text;
  }
  header.unshift(`URL: ${res.url || url}`);
  header.push(`STATUS: ${res.status}`);
  const clipped = out.length > maxChars;
  if (clipped || bodyTruncated) header.push(`TRUNCATED: yes (${out.length} chars extracted, showing ${Math.min(out.length, maxChars)})`);
  return header.join("\n") + "\n\n" + out.slice(0, maxChars);
}

// ---------- reddit ----------

type RedditPost = {
  title: string; score: number | null; num_comments: number | null; created: string;
  author: string; subreddit: string; url: string; permalink: string; flair: string | null;
  excerpt: string; upvote_ratio: number | null;
};

let redditTok: { token: string; exp: number } | null = null;

async function redditToken(): Promise<string | null> {
  if (!REDDIT_ID || !REDDIT_SECRET) return null;
  if (redditTok && redditTok.exp > Date.now() + 30_000) return redditTok.token;
  const res = await fetchWithTimeout("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "authorization": "Basic " + btoa(`${REDDIT_ID}:${REDDIT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": REDDIT_UA,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit OAuth failed: HTTP ${res.status} ${clip(await res.text(), 200)}`);
  const j = await res.json();
  redditTok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in ?? 3600) * 1000) };
  return redditTok.token;
}

function cleanSub(s: unknown): string {
  return String(s ?? "").trim().replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_+]/g, "");
}

function postFromApi(d: Record<string, unknown>): RedditPost {
  const permalink = "https://www.reddit.com" + String(d.permalink ?? "");
  const self = String(d.selftext ?? "").trim();
  return {
    title: String(d.title ?? ""),
    score: typeof d.score === "number" ? d.score : null,
    num_comments: typeof d.num_comments === "number" ? d.num_comments : null,
    created: isoFromUnix(Number(d.created_utc ?? 0)),
    author: String(d.author ?? ""),
    subreddit: String(d.subreddit ?? ""),
    url: String(d.url ?? permalink),
    permalink,
    flair: d.link_flair_text ? String(d.link_flair_text) : null,
    excerpt: clip(tidy(self), 400),
    upvote_ratio: typeof d.upvote_ratio === "number" ? d.upvote_ratio : null,
  };
}

function postsFromRss(xml: string, fallbackSub: string): RedditPost[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const out: RedditPost[] = [];
  for (const e of doc.querySelectorAll("entry")) {
    const link = e.querySelector("link")?.getAttribute("href") ?? "";
    const contentHtml = e.querySelector("content")?.textContent ?? "";
    const body = stripHtml(contentHtml).replace(/submitted by[\s\S]*$/, "").replace(/\[link\]|\[comments\]/g, "").trim();
    const external = rssExternalLink(contentHtml);
    const cat = e.querySelector("category")?.getAttribute("term") ?? fallbackSub;
    out.push({
      title: (e.querySelector("title")?.textContent ?? "").trim(),
      score: null,
      num_comments: null,
      created: (e.querySelector("updated")?.textContent ?? "").trim(),
      author: (e.querySelector("author > name")?.textContent ?? "").replace(/^\/u\//, ""),
      subreddit: cat,
      url: external ?? link,
      permalink: link,
      flair: null,
      excerpt: clip(body, 400),
      upvote_ratio: null,
    });
  }
  return out;
}

async function redditListing(apiPath: string, rssPath: string, params: Record<string, string>, sub: string, noRetry = false): Promise<{ posts: RedditPost[]; mode: string }> {
  const qs = new URLSearchParams(params).toString();
  const tok = await redditToken();
  if (tok) {
    const res = await fetchWithTimeout(`https://oauth.reddit.com${apiPath}?${qs}&raw_json=1`, {
      headers: { "authorization": `Bearer ${tok}`, "user-agent": REDDIT_UA },
    });
    if (!res.ok) throw new Error(`Reddit API HTTP ${res.status}: ${clip(await res.text(), 200)}`);
    const j = await res.json();
    const children = (j?.data?.children ?? []) as Array<{ data: Record<string, unknown> }>;
    return { posts: children.map((c) => postFromApi(c.data)), mode: "api" };
  }
  const res = await fetchRssPaced(`https://www.reddit.com${rssPath}?${qs}`, noRetry);
  if (res.status === 429 || res.status === 403) {
    throw new Error(`Reddit blocked unauthenticated access (HTTP ${res.status}). Reddit RSS mode is rate-limited from cloud IPs; set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET on the brief-fetch function for API mode.`);
  }
  if (!res.ok) throw new Error(`Reddit RSS HTTP ${res.status}`);
  return { posts: postsFromRss(await res.text(), sub), mode: "rss (no scores/comment counts in this mode)" };
}

// Unauthenticated Reddit allows roughly 10 requests/minute per IP and the edge IP is
// shared, so RSS mode paces itself (one request per ~6.5 s within a call) and retries
// once after a 429, honouring Retry-After when it is small.
const RSS_GAP_MS = 6500;
let lastRssAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRssPaced(url: string, noRetry = false): Promise<Response> {
  const headers = { "user-agent": BROWSER_UA, "accept": "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5" };
  const wait = lastRssAt + RSS_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRssAt = Date.now();
  let res = await fetchWithTimeout(url, { headers });
  if (res.status === 429 && !noRetry) {
    await res.body?.cancel();
    const ra = Number(res.headers.get("retry-after") ?? 0);
    await sleep(Math.min(Math.max(ra * 1000, 12_000), 30_000));
    lastRssAt = Date.now();
    res = await fetchWithTimeout(url, { headers });
  }
  return res;
}

function formatPosts(heading: string, posts: RedditPost[], mode: string): string {
  const lines = [`${heading} — ${posts.length} posts — source: ${mode}`];
  posts.forEach((p, i) => {
    const bits = [
      p.score !== null ? `score ${p.score}` : null,
      p.num_comments !== null ? `${p.num_comments} comments` : null,
      p.upvote_ratio !== null ? `${Math.round(p.upvote_ratio * 100)}% up` : null,
      p.created ? p.created : null,
      p.author ? `u/${p.author}` : null,
      p.subreddit ? `r/${p.subreddit}` : null,
      p.flair ? `[${p.flair}]` : null,
    ].filter(Boolean).join(" · ");
    lines.push(`${i + 1}. ${p.title}\n   ${bits}\n   ${p.permalink}${p.url && p.url !== p.permalink ? `\n   link: ${p.url}` : ""}${p.excerpt ? `\n   ${p.excerpt}` : ""}`);
  });
  return lines.join("\n");
}

const T_VALUES = new Set(["hour", "day", "week", "month", "year", "all"]);

async function redditTop(args: Record<string, unknown>): Promise<string> {
  const sub = cleanSub(args.subreddit);
  if (!sub) throw new Error("subreddit is required");
  const t = T_VALUES.has(String(args.t)) ? String(args.t) : "day";
  const limit = String(Math.min(Math.max(Number(args.limit ?? 15), 1), 50));
  const { posts, mode } = await redditListing(`/r/${sub}/top`, `/r/${sub}/top.rss`, { t, limit }, sub);
  return formatPosts(`r/${sub} top (${t})`, posts, mode);
}

async function redditSearch(args: Record<string, unknown>): Promise<string> {
  const q = String(args.query ?? "").trim();
  if (!q) throw new Error("query is required");
  const sub = cleanSub(args.subreddit);
  const sort = ["relevance", "new", "top", "comments"].includes(String(args.sort)) ? String(args.sort) : "new";
  const t = T_VALUES.has(String(args.t)) ? String(args.t) : "week";
  const limit = String(Math.min(Math.max(Number(args.limit ?? 15), 1), 50));
  const params: Record<string, string> = { q, sort, t, limit };
  if (sub) params.restrict_sr = "1";
  const base = sub ? `/r/${sub}/search` : "/search";
  const { posts, mode } = await redditListing(base, `${base}.rss`, params, sub || "");
  return formatPosts(`reddit search "${q}"${sub ? ` in r/${sub}` : ""} (${sort}, ${t})`, posts, mode);
}

async function redditScan(args: Record<string, unknown>): Promise<string> {
  const subs = (Array.isArray(args.subreddits) ? args.subreddits : String(args.subreddits ?? "").split(",")).map(cleanSub).filter(Boolean);
  if (!subs.length) throw new Error("subreddits is required (array or comma-separated)");
  const t = T_VALUES.has(String(args.t)) ? String(args.t) : "day";
  const limit = String(Math.min(Math.max(Number(args.limit_per ?? 8), 1), 25));
  const blocks: string[] = [];
  const skipped: string[] = [];
  const started = Date.now();
  const apiMode = Boolean(await redditToken());
  for (const sub of subs.slice(0, 15)) {
    // The edge runtime has a ~150 s wall clock; paced RSS mode fits ~10 subreddits.
    if (!apiMode && Date.now() - started > SCAN_BUDGET_MS) { skipped.push(sub); continue; }
    try {
      const { posts, mode } = await redditListing(`/r/${sub}/top`, `/r/${sub}/top.rss`, { t, limit }, sub, true);
      blocks.push(formatPosts(`r/${sub} top (${t})`, posts, mode));
    } catch (e) {
      blocks.push(`r/${sub}: ERROR ${(e as Error).message}`);
    }
  }
  if (skipped.length) {
    blocks.push(`NOT FETCHED (time budget in RSS mode): ${skipped.join(", ")} — call reddit_scan again with just these subreddits.`);
  }
  return blocks.join("\n\n");
}
const SCAN_BUDGET_MS = 95_000;

async function redditComments(args: Record<string, unknown>): Promise<string> {
  let ref = String(args.permalink ?? args.url ?? "").trim();
  if (!ref) throw new Error("permalink (or url) is required");
  try { ref = new URL(ref).pathname; } catch { /* already a path */ }
  ref = ref.replace(/\.json$|\.rss$/, "").replace(/\/+$/, "");
  if (!/^\/r\/[^/]+\/comments\//.test(ref)) throw new Error("expected a reddit post permalink like /r/<sub>/comments/<id>/...");
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 60);
  const tok = await redditToken();
  if (tok) {
    const res = await fetchWithTimeout(`https://oauth.reddit.com${ref}?limit=${limit}&depth=1&sort=top&raw_json=1`, {
      headers: { "authorization": `Bearer ${tok}`, "user-agent": REDDIT_UA },
    });
    if (!res.ok) throw new Error(`Reddit API HTTP ${res.status}: ${clip(await res.text(), 200)}`);
    const j = await res.json();
    const post = j?.[0]?.data?.children?.[0]?.data ?? {};
    const comments = (j?.[1]?.data?.children ?? []) as Array<{ kind: string; data: Record<string, unknown> }>;
    const lines = [
      `POST: ${post.title ?? ""} — score ${post.score ?? "?"} · ${post.num_comments ?? "?"} comments · ${post.created_utc ? isoFromUnix(Number(post.created_utc)) : ""} · r/${post.subreddit ?? ""}`,
      post.selftext ? clip(tidy(String(post.selftext)), 1500) : "",
      "",
      `TOP COMMENTS (${comments.filter((c) => c.kind === "t1").length}):`,
    ];
    for (const c of comments) {
      if (c.kind !== "t1") continue;
      const d = c.data;
      lines.push(`- [${d.score ?? "?"}] u/${d.author ?? ""}: ${clip(tidy(String(d.body ?? "")), 600)}`);
    }
    return lines.join("\n");
  }
  const res = await fetchRssPaced(`https://www.reddit.com${ref}.rss?limit=${limit}`);
  if (res.status === 429 || res.status === 403) {
    throw new Error(`Reddit blocked unauthenticated access (HTTP ${res.status}); set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET for API mode.`);
  }
  if (!res.ok) throw new Error(`Reddit RSS HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
  const entries = [...doc.querySelectorAll("entry")];
  const lines: string[] = [];
  entries.forEach((e, i) => {
    const who = (e.querySelector("author > name")?.textContent ?? "").replace(/^\/u\//, "");
    const raw = e.querySelector("content")?.textContent ?? "";
    const body = i === 0
      ? stripHtml(raw).replace(/submitted by[\s\S]*$/, "").replace(/\[link\]|\[comments\]/g, "").trim()
      : stripHtml(raw).trim();
    lines.push(i === 0 ? `POST: ${(e.querySelector("title")?.textContent ?? "").trim()}\n${clip(body, 1500)}\n\nCOMMENTS (rss mode, no scores):` : `- u/${who}: ${clip(body, 600)}`);
  });
  return lines.join("\n");
}

// ---------- tool: market_history ----------

async function marketHistory(args: Record<string, unknown>): Promise<string> {
  const symbol = String(args.symbol ?? "").trim();
  if (!symbol) throw new Error("symbol is required");
  const range = ["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "ytd", "max"].includes(String(args.range)) ? String(args.range) : "1mo";
  const interval = ["1d", "1wk", "1mo"].includes(String(args.interval)) ? String(args.interval) : "1d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div%2Csplit`;
  const res = await fetchWithTimeout(url, { headers: { "user-agent": BROWSER_UA, "accept": "application/json" } });
  const j = await res.json().catch(() => null);
  const err = j?.chart?.error;
  if (!res.ok || err) throw new Error(`Yahoo chart ${res.status}: ${err?.description ?? err?.code ?? "no data"} (symbol ${symbol})`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  const meta = r.meta ?? {};
  const ts: number[] = r.timestamp ?? [];
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const highs: (number | null)[] = r.indicators?.quote?.[0]?.high ?? [];
  const lows: (number | null)[] = r.indicators?.quote?.[0]?.low ?? [];
  const off = Number(meta.gmtoffset ?? 0);
  const rows: Array<{ d: string; c: number; h: number | null; l: number | null }> = [];
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      rows.push({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), c, h: highs[i] ?? null, l: lows[i] ?? null });
    }
  });
  if (!rows.length) throw new Error(`no closes for ${symbol}`);
  const first = rows[0], last = rows[rows.length - 1];
  const hi = rows.reduce((a, b) => (b.c > a.c ? b : a));
  const lo = rows.reduce((a, b) => (b.c < a.c ? b : a));
  const pct = ((last.c - first.c) / first.c) * 100;
  const dp = Math.abs(last.c) < 10 ? 4 : 2;
  const head = [
    `SYMBOL: ${meta.symbol ?? symbol}${meta.longName || meta.shortName ? ` (${meta.longName ?? meta.shortName})` : ""} · ${meta.currency ?? ""} · ${meta.exchangeName ?? ""} · ${meta.instrumentType ?? ""}`,
    `RANGE: ${range} / ${interval} · ${rows.length} bars · ${first.d} → ${last.d}`,
    `FIRST CLOSE ${first.c.toFixed(dp)} (${first.d}) · LAST CLOSE ${last.c.toFixed(dp)} (${last.d}) · CHANGE ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
    `HIGH CLOSE ${hi.c.toFixed(dp)} (${hi.d}) · LOW CLOSE ${lo.c.toFixed(dp)} (${lo.d})`,
    meta.regularMarketPrice ? `LATEST QUOTE ${Number(meta.regularMarketPrice).toFixed(dp)} at ${meta.regularMarketTime ? isoFromUnix(Number(meta.regularMarketTime)) : ""}` : "",
    "",
    "date        close" + (interval === "1d" ? "       high      low" : ""),
  ].filter((s) => s !== "");
  const body = rows.slice(-260).map((r) =>
    `${r.d}  ${r.c.toFixed(dp).padStart(10)}` + (interval === "1d" ? `  ${r.h !== null ? r.h.toFixed(dp).padStart(8) : "".padStart(8)}  ${r.l !== null ? r.l.toFixed(dp).padStart(8) : ""}` : "")
  );
  return head.concat(body).join("\n");
}

// ---------- MCP plumbing ----------

const TOOLS = [
  {
    name: "fetch_page",
    description: "Fetch a public web page and return its readable article text (title, byline, published date, body). Use this instead of WebFetch, which is blocked in the routine sandbox. Works for news articles, press releases, central-bank statements, arXiv abstracts, Wikipedia, JSON APIs. Returns HTTP status on failure. Text is truncated at max_chars (default 12000).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        max_chars: { type: "integer", description: "Max characters of extracted text to return (500–60000, default 12000)" },
        raw: { type: "boolean", description: "Return the raw response body instead of extracted article text (default false)" },
      },
      required: ["url"],
    },
  },
  {
    name: "reddit_top",
    description: "Top posts in one subreddit over a time window. Returns title, score, comment count, age, author, permalink, and a self-text excerpt. Lead-generation only: corroborate anything it surfaces with a primary source before stating it as fact.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: { type: "string", description: "Subreddit name without r/ (e.g. investing)" },
        t: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Time window (default day)" },
        limit: { type: "integer", description: "Posts to return, 1–50 (default 15)" },
      },
      required: ["subreddit"],
    },
  },
  {
    name: "reddit_scan",
    description: "Top posts across several subreddits in one call (the cheap way to sweep the Reddit beat list). Same fields as reddit_top.",
    inputSchema: {
      type: "object",
      properties: {
        subreddits: { type: "array", items: { type: "string" }, description: "Subreddit names without r/ (max 15)" },
        t: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Time window (default day)" },
        limit_per: { type: "integer", description: "Posts per subreddit, 1–25 (default 8)" },
      },
      required: ["subreddits"],
    },
  },
  {
    name: "reddit_search",
    description: "Search Reddit posts by keywords, optionally restricted to one subreddit. Use it to find discussion of a specific storyline (e.g. 'Hormuz tanker insurance').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        subreddit: { type: "string", description: "Restrict to this subreddit (optional)" },
        sort: { type: "string", enum: ["relevance", "new", "top", "comments"], description: "Sort (default new)" },
        t: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Time window (default week)" },
        limit: { type: "integer", description: "Posts to return, 1–50 (default 15)" },
      },
      required: ["query"],
    },
  },
  {
    name: "reddit_comments",
    description: "The post body plus its top-level comments (sorted by score) for one Reddit post. Pass the permalink returned by reddit_top / reddit_scan / reddit_search.",
    inputSchema: {
      type: "object",
      properties: {
        permalink: { type: "string", description: "Post permalink or full URL (…/r/<sub>/comments/<id>/…)" },
        limit: { type: "integer", description: "Max comments, 1–60 (default 20)" },
      },
      required: ["permalink"],
    },
  },
  {
    name: "market_history",
    description: "Daily closes for a market instrument from Yahoo Finance, with first/last/high/low and % change over the range. Use it to grade calls against real moves. Symbol conventions: equities by ticker (NVDA, 000660.KS); indexes with ^ (^GSPC, ^SOX, ^KS11, ^N225); US Treasury yields ^IRX (13w), ^FVX (5y), ^TNX (10y), ^TYX (30y); futures with =F (BZ=F Brent, CL=F WTI, GC=F gold, SI=F silver, NG=F US natgas, HG=F copper, LE=F live cattle); FX as EURUSD=X, JPY=X; dollar index DX-Y.NYB; ETFs by ticker (TLT, XLE, SMH).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Yahoo Finance symbol" },
        range: { type: "string", enum: ["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "ytd", "max"], description: "Lookback (default 1mo)" },
        interval: { type: "string", enum: ["1d", "1wk", "1mo"], description: "Bar size (default 1d)" },
      },
      required: ["symbol"],
    },
  },
];

const IMPL: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
  fetch_page: fetchPage,
  reddit_top: redditTop,
  reddit_scan: redditScan,
  reddit_search: redditSearch,
  reddit_comments: redditComments,
  market_history: marketHistory,
};

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type RpcMsg = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handle(m: RpcMsg): Promise<unknown | null> {
  const method = String(m.method ?? "");
  if (method.startsWith("notifications/")) return null;
  const id = m.id ?? null;
  switch (method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "brief-fetch", version: VERSION },
        instructions: "Web, Reddit and market-data access for The Brief routines. fetch_page replaces WebFetch; reddit_* replace search-based Reddit passes; market_history grades calls against real prices.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const fn = IMPL[name];
      if (!fn) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const text = await fn(args);
        return rpcResult(id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `ERROR: ${(e as Error)?.message ?? String(e)}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter(Boolean);
  const token = url.searchParams.get("key") ?? (segs.length >= 2 && segs[segs.length - 2] === "mcp" ? segs[segs.length - 1] : null);
  if (!token || token !== TOKEN) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    return new Response(`brief-fetch MCP server ${VERSION}. POST JSON-RPC (Streamable HTTP, stateless) to this URL.`, {
      status: 405,
      headers: { "allow": "POST", "content-type": "text/plain" },
    });
  }
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { "allow": "POST" } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "parse error"), 400);
  }
  const msgs = (Array.isArray(body) ? body : [body]) as RpcMsg[];
  const out: unknown[] = [];
  for (const m of msgs) {
    const r = await handle(m);
    if (r !== null) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
});
