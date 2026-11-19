#!/bin/sh
set -eu
mode=${1:-direct}
[ "$#" -le 1 ] || { echo 'usage: sh deploy/install-launchd.sh [direct|shared|standalone|tunnel]' >&2; exit 2; }
case "$mode" in direct|shared|standalone|tunnel) ;; *) echo 'choose direct, shared, standalone or tunnel' >&2; exit 2 ;; esac
[ "$(uname -s)" = Darwin ] || { echo 'macOS required' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Run as the MAGI service account.' >&2; exit 1; }
project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
gateway="$HOME/Library/LaunchAgents/local.me1-downloads.web.plist"
if [ "$mode" = direct ]; then
  if [ -f "$gateway" ]; then mode=shared; else mode=standalone; fi
fi
if [ "$mode" = standalone ]; then
  if [ -f "$gateway" ]; then echo 'Existing ME1 gateway: use shared.' >&2; exit 1; fi
  # An existing MAGI daemon may be refreshed. Any other listener owns this port.
  if /usr/sbin/netstat -an -p tcp | awk '$6 == "LISTEN" && $4 ~ /[.:]443$/ { found=1 } END { exit !found }'; then
    own_pid=$(/bin/launchctl print system/cn.lanthan.magi.caddy 2>/dev/null | awk '$1=="pid" {print $3; exit}')
    listeners=$(/usr/sbin/lsof -nP -t -iTCP:443 -sTCP:LISTEN 2>/dev/null | sort -u)
    if [ -z "$own_pid" ] || [ "$listeners" != "$own_pid" ]; then echo 'TCP 443 is in use. Use the existing gateway.' >&2; exit 1; fi
  fi
fi
account=$(id -un)
if [ -x "$project/.runtime/node22/bin/node" ]; then
  PATH="$project/.runtime/node22/bin:$PATH"
  export PATH
fi
node_bin=$(command -v node) || { echo 'Add Node 22 to PATH before installing MAGI.' >&2; exit 1; }
[ -f "$project/.env" ] && [ -f "$project/server/dist/src/index.js" ] || { echo 'Configure .env and run npm run build first.' >&2; exit 1; }
[ "$("$node_bin" -p 'process.versions.node.split(".")[0]')" = 22 ] || { echo 'Use Node 22' >&2; exit 1; }
if [ "$mode" = shared ]; then
  exec /usr/bin/python3 -B "$project/deploy/shared_gateway.py" install "$node_bin"
fi
logs="$HOME/Library/Logs/MAGI"
mkdir -p "$logs"
chmod 700 "$logs"
export MAGI_LOG_DIR="$logs"
if [ "$mode" = standalone ]; then
  caddy_bin=$(command -v caddy)
  "$caddy_bin" validate --config "$project/deploy/Caddyfile" --adapter caddyfile
  jobs='node caddy ddns'
else
  jobs='node'
fi
temp_plist=$(mktemp)
trap 'rm -f "$temp_plist"' EXIT
for job in $jobs; do
  label="cn.lanthan.magi.$job"
  cp "$project/deploy/launchd/$label.plist" "$temp_plist"
  binary=$node_bin
  if [ "$job" = caddy ]; then binary=$caddy_bin; fi
  plutil -replace UserName -string "$account" "$temp_plist"
  plutil -replace EnvironmentVariables.HOME -string "$HOME" "$temp_plist"
  if [ "$job" = caddy ]; then plutil -replace EnvironmentVariables.MAGI_LOG_DIR -string "$logs" "$temp_plist"; fi
  plutil -replace WorkingDirectory -string "$project" "$temp_plist"
  plutil -replace ProgramArguments.0 -string "$binary" "$temp_plist"
  plutil -replace StandardOutPath -string "$logs/$job.log" "$temp_plist"
  plutil -replace StandardErrorPath -string "$logs/$job.error.log" "$temp_plist"
  plutil -lint "$temp_plist"
  target="/Library/LaunchDaemons/$label.plist"
  if sudo launchctl print "system/$label" >/dev/null 2>&1; then sudo launchctl bootout "system/$label"; fi
  sudo /usr/bin/install -o root -g wheel -m 644 "$temp_plist" "$target"
  sudo launchctl enable "system/$label"
  sudo launchctl bootstrap system "$target"
done
