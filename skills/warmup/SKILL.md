---
name: warmup
description: Audit captured Claude Code tool and skill descriptions, manage exclusions, and build or refresh ~/.claude/cc-simplify/slim.json with hash-pinned summaries.
disable-model-invocation: true
---

# /cc-simplify:warmup

All-in-one setup, audit, and incremental refresh for `cc-simplify`.
Reads `~/.claude/cc-simplify/captured.json` (auto-captured by the plugin from the live Claude Code runtime) and writes `~/.claude/cc-simplify/slim.json`.

## Hard Rules

1. **Zero removal**: Never remove any tool or skill. Only summarize descriptions; full originals stay retrievable via `get_doc`.
2. **Hash-pinned**: Every entry in `slim.json` MUST copy the exact `hash` from `captured.json` so future Claude Code updates automatically detect drift and fall back safely to passthrough.
3. **Preserve every guardrail**:
   - Tools: keep all MUST / NEVER / opt-in / destructive / permission rules, and end with `Call get_doc({ targets: ["tool:<Name>"] }) before first use.` (or `for full details.` for high-frequency tools).
   - High-frequency tools (if user chooses to slim them): keep compact operational rules so the model can use them without extra `get_doc` round-trips.
   - Skills: keep purpose + necessary trigger keywords (including non-English triggers at the end) + `NOT for` / `SKIP` / user-only invocation constraints. Single line only (no embedded newlines).
4. **Respect exclusions**: Never slim any item in `slim.json -> exclude.tools` or `exclude.skills`.

## Workflow

1. **Load snapshot & local config**
   - Check `~/.claude/cc-simplify/captured.json` and (if present) `~/.claude/cc-simplify/slim.json`.
   - If `captured.json` is large, list entries (`name`, `chars`, `hash`) first via a short script, and only load full `text` for entries the user approves to warm up or refresh.
   - If `captured.json` is missing or empty, briefly explain what `cc-simplify` does (see Step 3) and tell the user to send one message with `cc-simplify` loaded (or run `claude -p "hi" --plugin-dir <plugin-dir>`) so the plugin captures live descriptions first, then re-run `/cc-simplify:warmup`.

2. **Audit & form a practical recommendation**
   Compare `captured.json` vs `slim.json`. Do NOT mechanically split by "built-in vs. plugin" or push the user to slim everything over a tiny cutoff. Judge each item by **size × frequency × sensitivity** and group candidates into clear, reasoned tiers:
   - **Recommended to slim (high payoff, low risk)**: low-frequency tools with huge descriptions (e.g. multi-kilobyte tools rarely used in day-to-day sessions) and overly verbose skills whose headers pack long examples or body rules.
   - **Recommended to keep verbatim (skip / `exclude`)**:
     - High-frequency tools or go-to skills where full rules prevent mistakes or avoid extra `get_doc` round-trips;
     - Modest-sized items—**even built-in ones**—whose original text is already small enough that saving a few dozen or hundred tokens isn't worth any risk to accuracy or trigger precision.
   - **Optional (your call)**: items that are both frequently used and genuinely large (e.g. a very long primary shell tool, or a large batch of verbose plugin skills)—state the estimated token savings vs. trade-off so the user can decide.
   - Also list any **Active** (`slim.hash === captured.hash`), **Drifted** (`slim.hash !== captured.hash`), and **Excluded** items concisely.

3. **Explain clearly & confirm scope with the user**
   - **On first-time warmup (`slim.json` missing or empty)**, BEFORE asking the user to pick items, briefly explain in plain language:
     1. **What `cc-simplify` does**: Never removes any tool or skill. It only trims verbose first-turn descriptions into guardrail-preserving summaries; when the model actually needs full instructions, it calls `get_doc` on demand (no Prompt Cache break). If a Claude Code update changes an original description, the hash mismatch automatically falls back to the full new text and reminds you to re-run warmup.
     2. **How to choose**: Summarize the reasoned tiers above with concrete estimated savings—lead with a sensible default proposal (slim the low-frequency heavyweights, keep high-frequency and modest-sized items verbatim—built-in or not) so the user can approve or tweak in one line.
     3. **Easy to adjust or turn off anytime**: If any slimmed tool behaves worse or a skill misses triggers, add that single item to `exclude` in `~/.claude/cc-simplify/slim.json` (or re-run `/cc-simplify:warmup`) to restore its original; deleting `~/.claude/cc-simplify/slim.json` reverts everything to passthrough. Changes apply on `/clear` or the next new session.
   - **On incremental update / audit (existing `slim.json`)**: skip the full intro; show the concise status/drift table with reasoned recommendations for drifted or newly heavy items, and ask what to refresh, exclude/un-exclude, add, or hand-tune.

4. **Generate & write `~/.claude/cc-simplify/slim.json`**
   - Draft each approved summary directly from `captured.json[kind][name].text`, copying its exact `hash`.
   - Preserve existing up-to-date entries and `exclude` lists unless the user asked to change them.
   - Write formatted JSON to `~/.claude/cc-simplify/slim.json`:
     ```json
     {
       "version": 1,
       "exclude": { "tools": ["PowerShell"], "skills": [] },
       "tools": {
         "Workflow": { "hash": "<exact hash from captured.json>", "summary": "..." }
       },
       "skills": {
         "dataviz": { "hash": "<exact hash from captured.json>", "summary": "..." }
       }
     }
     ```

5. **Report outcome**
   - Report counts (warmed/refreshed/excluded), estimated total chars/tokens saved, and remind the user that changes apply on the **next new session or `/clear`** (keeping the current session's Prompt Cache intact).
