#!/usr/bin/env bash
# Install / remove / inspect the brainrot launchd agents.
#
#   ./deploy/launchd/agents.sh install     symlink into ~/Library/LaunchAgents and bootstrap
#   ./deploy/launchd/agents.sh uninstall   bootout and remove the symlinks
#   ./deploy/launchd/agents.sh status      show whether each agent is loaded, and its last exit code
#   ./deploy/launchd/agents.sh kick <name> run one agent immediately (e.g. kick scout)
#
# Agents are symlinked, not copied, so the repo stays the single source of
# truth. launchd reads a plist at bootstrap time, so after editing one you
# must `uninstall && install` for the change to take effect.
#
# IMPORTANT: manual brainrot commands (produce, resume, auth youtube,
# library approve/reject, publish retry/mark-done) run OUTSIDE the loop
# leases and can race a live tick. Run `uninstall`, or at least bootout the
# relevant agent, before driving the pipeline by hand.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/deploy/launchd"
DEST="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
AGENTS=(scout produce-next publish-next digest)

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

cmd_install() {
  mkdir -p "$DEST" "$REPO/logs"
  for a in "${AGENTS[@]}"; do
    local label="com.brainrot.$a"
    local plist="$SRC/$label.plist"
    [[ -f "$plist" ]] || { echo "missing $plist" >&2; exit 1; }
    plutil -lint "$plist" >/dev/null || { echo "malformed $plist" >&2; exit 1; }
    # Idempotent: tolerate "not loaded" on a fresh install.
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    ln -sf "$plist" "$DEST/$label.plist"
    launchctl bootstrap "$DOMAIN" "$DEST/$label.plist"
    echo "loaded  $label"
  done
  echo
  echo "Installed. Ticks begin after their first interval; nothing fires immediately."
  cmd_status
}

cmd_uninstall() {
  for a in "${AGENTS[@]}"; do
    local label="com.brainrot.$a"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null && echo "booted out  $label" || echo "not loaded  $label"
    rm -f "$DEST/$label.plist"
  done
}

cmd_status() {
  printf '%-28s %-12s %-6s %s\n' AGENT LOADED RUNS 'LAST EXIT'
  for a in "${AGENTS[@]}"; do
    local label="com.brainrot.$a" info runs last
    if info="$(launchctl print "$DOMAIN/$label" 2>/dev/null)"; then
      # "last exit code = 0" or "last exit code = (never exited)"
      runs="$(sed -n 's/^[[:space:]]*runs = \(.*\)$/\1/p' <<<"$info" | head -1)"
      last="$(sed -n 's/^[[:space:]]*last exit code = \(.*\)$/\1/p' <<<"$info" | head -1)"
      [[ "$last" == "(never exited)" ]] && last="never run"
      printf '%-28s %-12s %-6s %s\n' "$label" yes "${runs:-0}" "${last:-?}"
    else
      printf '%-28s %-12s %-6s %s\n' "$label" no '-' '-'
    fi
  done
}

cmd_kick() {
  local a="${1:-}"
  [[ -n "$a" ]] || usage
  launchctl kickstart -p "$DOMAIN/com.brainrot.$a"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  kick)      shift; cmd_kick "$@" ;;
  *)         usage ;;
esac
