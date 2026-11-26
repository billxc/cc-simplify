# cc-simplify

A Claude Code function-hooks plugin that slims verbose tool and skill descriptions in the initial context while keeping every tool and skill available—with full originals loaded on demand via `get_doc`.

## How It Works

- **Zero built-in list**: Ships with no hardcoded summaries. On first use, the plugin passes everything through untouched, snapshots live tool and skill descriptions into `~/.claude/cc-simplify/captured.json`, and prompts you to run `/cc-simplify:warmup`.
- **Zero removal**: Never removes any tool or skill. Only trims initial descriptions for items you approve in `~/.claude/cc-simplify/slim.json`; full originals are persisted and retrieved on demand via the native read-only `get_doc` tool without breaking Prompt Cache.
- **Drift-safe across Claude Code updates**: Each summary is pinned to a 64-bit hash of the original description. When a Claude Code update changes an original description, that entry automatically falls back to passthrough and notifies you to re-run `/cc-simplify:warmup`.
- **Easy to exclude or disable**: Add any item to `exclude.tools` / `exclude.skills` in `~/.claude/cc-simplify/slim.json` to keep it verbatim, or delete `slim.json` to return to full passthrough. Changes apply on `/clear` or the next new session.

## Install

In a Claude Code terminal session:

```text
/plugin install cc-simplify --marketplace billxc/cc-simplify
```

Or from a shell:

```bash
claude plugin install cc-simplify --marketplace billxc/cc-simplify
```

In Claude Code Desktop: click `+` next to the prompt box → **Plugins** → **Add marketplace** (`billxc/cc-simplify`) → **Add plugin** (`cc-simplify`).

## Quick Start

1. Start a session with `cc-simplify` enabled and send one prompt so live tool/skill descriptions are captured to `~/.claude/cc-simplify/captured.json`.
2. Run `/cc-simplify:warmup` to review tiered recommendations, choose exclusions, and generate `~/.claude/cc-simplify/slim.json`.
3. Run `/clear` or start a new session for the slimmed context to take effect.
