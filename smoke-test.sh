#!/usr/bin/env bash
# Smoke-test the deployed brief-fetch MCP server with raw JSON-RPC.
# Usage: BRIEF_FETCH_URL=https://<project-ref>.supabase.co/functions/v1/brief-fetch MCP_TOKEN=... ./smoke-test.sh
set -euo pipefail
: "${MCP_TOKEN:?set MCP_TOKEN}"
: "${BRIEF_FETCH_URL:?set BRIEF_FETCH_URL to https://<project-ref>.supabase.co/functions/v1/brief-fetch}"
URL="${BRIEF_FETCH_URL}/mcp/${MCP_TOKEN}"
rpc() { curl -sS -X POST "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1"; echo; }
echo "== bad token (expect 401)"; curl -sS -o /dev/null -w "%{http_code}\n" -X POST "${URL}x" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":0,"method":"ping"}'
echo "== initialize"; rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
echo "== tools/list"; rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | head -c 600; echo
echo "== fetch_page"; rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fetch_page","arguments":{"url":"https://www.federalreserve.gov/newsevents/pressreleases.htm","max_chars":800}}}' | head -c 1200; echo
echo "== market_history"; rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"market_history","arguments":{"symbol":"BZ=F","range":"5d"}}}' | head -c 900; echo
echo "== reddit_top"; rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"reddit_top","arguments":{"subreddit":"economics","limit":3}}}' | head -c 900; echo
