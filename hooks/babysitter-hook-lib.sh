#!/bin/bash
# Shared runtime for the Babysitter Codex hook wrappers.
# Sourced by hooks/babysitter-proxied-*.sh; not executed directly.
#
# Codex invokes hook commands through the user's shell with the session cwd.
# Plugin-sourced hooks run with PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT pointing at
# the installed bundle; surface copies installed under <codexHome>/hooks or
# <workspace>/.codex/hooks get neither, so every path here is derived from
# the script location (BSIT_SCRIPT_DIR, set by the sourcing script).

BSIT_MARKER=".babysitter-managed-surface"

# Codex may run hooks with a minimal PATH (GUI launch, scrubbed env). Append
# the common npm/node global bin locations so the SDK CLIs resolve.
bsit_extend_path() {
  local dir
  for dir in \
    "${HOME:-}/.local/bin" \
    "${HOME:-}/.npm-global/bin" \
    "${HOME:-}/.volta/bin" \
    "${NVM_BIN:-}" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$PATH:$dir" ;;
    esac
  done
  export PATH
}

# Print the hooks dir of the surface that owns this event, if any. Precedence:
# nearest workspace surface walking up from the session cwd, then the Codex
# home surface (${CODEX_HOME:-$HOME/.codex}). A surface only counts when both
# its marker and this event's script exist, so a stale marker or half-removed
# install can never silently swallow events.
bsit_owning_surface() {
  local script_name="$1" d dir
  d="$PWD"
  while :; do
    if [ -f "$d/.codex/hooks/$BSIT_MARKER" ] && [ -f "$d/.codex/hooks/$script_name" ]; then
      printf '%s\n' "$d/.codex/hooks"
      return 0
    fi
    [ "$d" = "/" ] && break
    d="$(dirname "$d")"
  done
  dir="${CODEX_HOME:-${HOME:-}/.codex}/hooks"
  if [ -f "$dir/$BSIT_MARKER" ] && [ -f "$dir/$script_name" ]; then
    printf '%s\n' "$dir"
    return 0
  fi
  return 1
}

# Decide whether this copy of the script should handle the event. Exactly one
# copy runs: the owning surface if one is live, otherwise the plugin bundle.
bsit_should_run() {
  local script_name="$1" owner
  if owner="$(bsit_owning_surface "$script_name")"; then
    # A live surface owns the event; only its own copy proceeds.
    [ "$BSIT_SCRIPT_DIR" -ef "$owner" ]
    return
  fi
  # No live surface is visible: the plugin-bundle copy handles the event. A
  # surface copy invoked outside its install-time environment (its config was
  # loaded, so no other copy will fire) also proceeds.
  return 0
}

bsit_sdk_version() {
  local f
  for f in "$BSIT_SCRIPT_DIR/../versions.json" "$BSIT_SCRIPT_DIR/versions.json"; do
    if [ -f "$f" ]; then
      node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sdkVersion||'latest')}catch{console.log('latest')}" "$f" 2>/dev/null && return 0
    fi
  done
  echo latest
}

# Install the pinned SDK when missing. Attempts are stamped and retried at
# most every 6 hours so an offline/unwritable machine does not pay two npm
# registry timeouts on every session start.
bsit_ensure_sdk() {
  command -v babysitter >/dev/null 2>&1 && return 0

  local stamp_dir="${HOME:-/tmp}/.a5c" stamp now last
  stamp="$stamp_dir/.codex-sdk-install-attempt"
  now="$(date +%s 2>/dev/null || echo 0)"
  last="$(cat "$stamp" 2>/dev/null || echo 0)"
  case "$last" in *[!0-9]*) last=0 ;; esac
  [ $((now - last)) -lt 21600 ] && return 1
  mkdir -p "$stamp_dir" 2>/dev/null && printf '%s' "$now" > "$stamp" 2>/dev/null

  local version
  version="$(bsit_sdk_version)"
  npm i -g "@a5c-ai/babysitter-sdk@${version}" --loglevel=error >/dev/null 2>&1 || \
    npm i -g "@a5c-ai/babysitter-sdk@${version}" --prefix "${HOME:-}/.local" --loglevel=error >/dev/null 2>&1 || true
  [ -d "${HOME:-}/.local/bin" ] && export PATH="${HOME:-}/.local/bin:$PATH"
  command -v babysitter >/dev/null 2>&1
}

# Resolve the adapters-hooks bin: PATH first, then next to the babysitter bin
# (@a5c-ai/babysitter-sdk ships both bins from the same package).
bsit_resolve_adapters_hooks() {
  if command -v adapters-hooks >/dev/null 2>&1; then
    command -v adapters-hooks
    return 0
  fi
  local babysitter_bin sibling
  babysitter_bin="$(command -v babysitter 2>/dev/null)" || return 1
  sibling="$(dirname "$babysitter_bin")/adapters-hooks"
  if [ -x "$sibling" ]; then
    echo "$sibling"
    return 0
  fi
  return 1
}

# bsit_invoke <hook-type>
# Pipes the Codex hook payload (stdin) through the codex hooks adapter into
# the Babysitter SDK. Exits 0 without output when another copy owns the event
# or the SDK is unavailable, so a partial install never breaks the session.
bsit_invoke() {
  local hook_type="$1"

  bsit_should_run "babysitter-proxied-$hook_type.sh" || exit 0

  bsit_extend_path

  if [ "$hook_type" = "session-start" ]; then
    bsit_ensure_sdk || true
  fi

  local adapters_hooks
  if ! adapters_hooks="$(bsit_resolve_adapters_hooks)"; then
    echo "[babysitter] $hook_type hook skipped: babysitter/adapters-hooks CLI not found on PATH. Install with: npm install -g @a5c-ai/babysitter-sdk" >&2
    exit 0
  fi

  exec "$adapters_hooks" invoke --adapter codex \
    --handler "babysitter hook:run --harness unified --hook-type $hook_type --json" \
    --json
}
