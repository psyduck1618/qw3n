#!/usr/bin/env bash
# Start the QW3N local chat server and open it in your browser.
#
#   ./run.sh                      local + home wifi
#   ./run.sh --tunnel             also reachable from anywhere
#   ./run.sh --tunnel tailscale   be explicit about the provider
#   ./run.sh --no-auth            skip the password (trusted network only)
#
# Any other flag is passed straight through to server.py.
set -euo pipefail

cd "$(dirname "$0")"

args=()
prev=""
for arg in "$@"; do
  if [ "$prev" = "--tunnel" ] && [ "$arg" != "auto" ] && ! command -v "$arg" >/dev/null 2>&1; then
    echo "  $arg is not installed — trying the other tunnel provider instead"
    arg="auto"
  fi
  args+=("$arg")
  prev="$arg"
done

# a bare `--tunnel` still needs a value for argparse
if [ ${#args[@]} -gt 0 ] && [ "${args[$((${#args[@]} - 1))]}" = "--tunnel" ]; then
  args+=("auto")
fi

if ! curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "  ollama is not running — starting it in the background..."
  (ollama serve >/tmp/ollama.log 2>&1 &)
  sleep 2
fi

# ${args[@]+...} keeps `set -u` happy on bash 3.2, where an empty array is unbound
exec python3 server.py --open ${args[@]+"${args[@]}"}
