# @a5c-ai/babysitter-codex

Babysitter integration package for OpenAI Codex CLI.

This package ships a real Codex plugin bundle:

- `.codex-plugin/plugin.json`
- `skills/`
- `hooks.json`
- `hooks/`

It still uses the Babysitter SDK CLI and the shared `~/.a5c` process-library
state. Global install writes the plugin bundle to `~/.agents/plugins/babysitter`
and updates `.agents/plugins/marketplace.json` (primary) so Codex can load the
plugin through its marketplace surface. Codex also recognizes
`.claude-plugin/marketplace.json` as a legacy marketplace path. Workspace
install continues to materialize a workspace-local Codex surface for team setup.

Codex now ships an official marketplace CLI (`codex plugin marketplace`) that
supports `add`, `list`, `upgrade`, and `remove` subcommands. Plugin bundles
installed through the marketplace are cached under
`~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`.

## Installation

Install the Babysitter CLI once:

```bash
npm install -g @a5c-ai/babysitter
```

Install the Codex plugin through the SDK helper. This is the canonical path used by the installer tests and resolves to `npx --yes @a5c-ai/babysitter-codex install ...` under the hood:

```bash
# Global install
babysitter harness:install-plugin codex

# Workspace install
babysitter harness:install-plugin codex --workspace /path/to/repo
```

You can also run the published package installer directly:

```bash
npx --yes @a5c-ai/babysitter-codex install --global
npx --yes @a5c-ai/babysitter-codex install --workspace /path/to/repo
```

Alternatively, use the official Codex marketplace CLI. This repo ships a
self-contained codex marketplace manifest (`.agents/plugins/marketplace.json`),
so add it directly and install the `babysitter` plugin from it:

```bash
codex plugin marketplace add a5c-ai/babysitter-codex
codex plugin add babysitter --marketplace babysitter
```

> `--marketplace babysitter` is the marketplace **name** declared in
> `.agents/plugins/marketplace.json` (not the repo name).

You can also add the marketplace from the **monorepo** with a sparse checkout, or
from a local clone:

```bash
codex plugin marketplace add a5c-ai/babysitter --ref main --sparse .agents/plugins
codex plugin marketplace add ./path/to/babysitter-codex
```

> For the monorepo form, use the released default branch (`main`) or a released
> tag for `--ref` — **never** `--ref staging`. Codex resolves a released plugin
> version; a `6.0.x-staging.*` build-metadata prerelease will not resolve.

Then browse and install:

```bash
codex plugin list --marketplace babysitter
codex plugin add babysitter --marketplace babysitter
```

Other marketplace commands:

```bash
codex plugin marketplace list
codex plugin marketplace upgrade babysitter
codex plugin marketplace remove babysitter
```

Then open Codex and finish enabling the plugin from the plugin UI:

```text
/plugins
```

Navigate to the `babysitter` entry and select `Install`.

If Codex was already open when you ran `install --global`, start a new thread
after installing from `/plugins` before expecting `babysitter:*` skills such as
`$babysitter:babysit` or `$babysitter:call` to appear in the mention picker.

## Integration Model

The plugin provides:

- `skills/babysit/SKILL.md` as the core entrypoint
- mode wrapper skills such as `$call`, `$plan`, and `$resume`
- plugin-level lifecycle hooks for `SessionStart`, `SessionEnd`,
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`

Hooks can be wired through more than one surface, and exactly one copy fires
per event:

- **Plugin bundle** — `hooks.json` commands resolve their scripts through
  `${CLAUDE_PLUGIN_ROOT}` / `${PLUGIN_ROOT}`, which Codex sets for
  plugin-sourced hooks (and no-op cleanly when neither is set). Used when the
  plugin is installed through the Codex marketplace
  (`codex plugin add babysitter`).
- **Managed `.codex` surface** — `install --global` copies the hook scripts
  into `<codexHome>/hooks/` (`$CODEX_HOME` or `~/.codex`) and merges
  absolute-path entries into `<codexHome>/hooks.json`; `install --workspace`
  does the same under `<workspace>/.codex/`. These files are machine-local —
  teammates rerun the installer rather than committing them.

Each event is claimed by the nearest live surface — a workspace surface found
by walking up from the session cwd wins over the Codex-home surface, which
wins over the plugin bundle. A surface counts as live only when both its
`.babysitter-managed-surface` marker and the event's script exist, so a stale
or half-removed install can never silently swallow events.

The process library is fetched and bound through the SDK CLI in
`~/.a5c/active/process-library.json`.

## Hook Environment Variables

Codex exposes the following environment variables to hook scripts:

| Variable | Description |
|---|---|
| `PLUGIN_ROOT` | Absolute path to the plugin root directory (native) |
| `PLUGIN_DATA` | Persistent data directory for the plugin (native) |
| `CLAUDE_PLUGIN_ROOT` | Compatibility alias for `PLUGIN_ROOT` |
| `CLAUDE_PLUGIN_DATA` | Compatibility alias for `PLUGIN_DATA` |

Hook scripts should prefer `PLUGIN_ROOT` / `PLUGIN_DATA` but can read the
`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` aliases for cross-harness
compatibility with Claude Code plugins.

Codex auto-detects hooks via `./hooks/hooks.json`. The `hooks` field in
`.codex-plugin/plugin.json` accepts a path, an array of paths, an inline
object, or an array of objects.

## Workspace Output

After `install --workspace`, the important files are:

- `.agents/plugins/babysitter/.codex-plugin/plugin.json`
- `.agents/plugins/babysitter/skills/babysit/SKILL.md`
- `.agents/plugins/babysitter/hooks.json`
- `.codex/skills/`
- `.codex/hooks/`
- `.codex/hooks.json`
- `.agents/plugins/marketplace.json`
- `.codex/config.toml`
- `.a5c/team/install.json`
- `.a5c/team/profile.json`

## Verification

Verify the installed plugin bundle:

```bash
npm ls -g @a5c-ai/babysitter-codex --depth=0
test -f ~/.agents/plugins/babysitter/.codex-plugin/plugin.json
test -f ~/.agents/plugins/babysitter/hooks.json
test -f ~/.agents/plugins/babysitter/hooks/babysitter-proxied-stop.sh
test -f ~/.agents/plugins/babysitter/skills/babysit/SKILL.md
test -f ~/.agents/plugins/marketplace.json
```

Verify the active shared process-library binding:

```bash
babysitter process-library:active --json
```

On native Windows, Codex hooks require **Codex CLI >= 0.119.0** (released
2026-04-10, [openai/codex#17268](https://github.com/openai/codex/pull/17268)).
Older Codex versions silently skipped hook execution on Windows. If hooks do
not fire after install, run `codex --version` and upgrade if needed.

## Troubleshooting Hooks

If Babysitter hooks do not appear to run:

1. **Check the hooks feature is on.** `~/.codex/config.toml` (or the workspace
   `.codex/config.toml`) must contain `[features]` with `hooks = true`. The
   installer merges this automatically; re-run the installer if it is missing.
2. **Trust the hooks.** Codex gates newly discovered hooks behind a trust
   prompt. Open the hooks browser inside Codex (`/hooks`) and approve the
   `babysitter-proxied-*` handlers if they are listed as untrusted.
3. **Check the SDK CLI resolves.** Hooks proxy into `babysitter` and
   `adapters-hooks` from `@a5c-ai/babysitter-sdk`. Run
   `command -v babysitter adapters-hooks`; if missing, run
   `npm install -g @a5c-ai/babysitter-sdk`. When the SDK is missing the hooks
   exit quietly (they never break your Codex session) and log a
   `[babysitter] ... hook skipped` line to stderr.
4. **Check the scripts exist where the config points.** For a global install:
   `ls ~/.codex/hooks/babysitter-proxied-*.sh` and confirm the commands in
   `~/.codex/hooks.json` use absolute paths. For a workspace install the same
   files live under `<workspace>/.codex/`. For a marketplace install the
   scripts live in the plugin bundle and the commands resolve via
   `${CLAUDE_PLUGIN_ROOT}`.
5. **Reinstall to repair.** Re-running the installer is idempotent: it
   replaces stale managed entries (including ones from older package versions)
   without duplicating them and without touching hooks you added yourself.

## License

MIT
