import type { EngineInterface, Register } from 'claude-code'

export const DOC_TOOL_NAME = 'get_doc'

const DOC_TOOL_MATCH = /^get_doc$/
const SKILL_LIST_MARKER = 'The following skills are available for use with the Skill tool:'
const TOOL_STORE_PREFIX = 'doc:tool:'
const SKILL_STORE_PREFIX = 'doc:skill:'
const DATA_DIR_REL = '.claude/cc-simplify'

export type SlimEntry = {
  hash: string
  summary: string
}

export type SlimConfig = {
  version?: number
  exclude?: {
    tools?: string[]
    skills?: string[]
  }
  tools?: Record<string, SlimEntry>
  skills?: Record<string, SlimEntry>
}

export type CapturedEntry = {
  hash: string
  chars: number
  text: string
}

export type CapturedSnapshot = {
  tools: Record<string, CapturedEntry>
  skills: Record<string, CapturedEntry>
}

type RuntimeState = {
  configPromise: Promise<SlimConfig | null> | null
  capturedCache: CapturedSnapshot | null
  writeChain: Promise<void>
  notifiedUnwarmed: boolean
  driftedNames: Set<string>
  lastDriftToastCount: number
}

/** Deterministic 64-bit (dual FNV-1a) hex hash for drift detection. */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= c + i
    h2 = Math.imul(h2, 0x85ebca6b)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

function toolKey(name: string): string {
  return `${TOOL_STORE_PREFIX}${name}`
}

function skillKey(name: string): string {
  return `${SKILL_STORE_PREFIX}${name}`
}

function hasAnySlimEntry(cfg: SlimConfig | null): boolean {
  if (!cfg) return false
  return Object.keys(cfg.tools ?? {}).length > 0 || Object.keys(cfg.skills ?? {}).length > 0
}

async function resolveDataPaths($: EngineInterface): Promise<{
  slimPath: string
  capturedPath: string
} | null> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return null
  const base = `${home.replace(/[\\/]+$/, '')}/${DATA_DIR_REL}`
  return {
    slimPath: `${base}/slim.json`,
    capturedPath: `${base}/captured.json`,
  }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    const raw = await $.fs.read(path)
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type StoredDoc = {
  hash: string
  text: string
}

async function persistDoc(
  $: EngineInterface,
  key: string,
  hash: string,
  text: string,
): Promise<boolean> {
  try {
    const payload: StoredDoc = { hash, text }
    await $.store.set(key, payload)
    return true
  } catch {
    return false
  }
}

function loadConfig($: EngineInterface, state: RuntimeState): Promise<SlimConfig | null> {
  if (!state.configPromise) {
    state.configPromise = (async () => {
      const paths = await resolveDataPaths($)
      if (!paths) return null
      return readJson<SlimConfig>($, paths.slimPath)
    })()
  }
  return state.configPromise
}

async function recordCaptured(
  $: EngineInterface,
  state: RuntimeState,
  kind: 'tools' | 'skills',
  updates: Array<{ name: string; text: string; hash: string }>,
): Promise<void> {
  if (updates.length === 0) return
  const task = state.writeChain.then(async () => {
    const paths = await resolveDataPaths($)
    if (!paths) return
    if (!state.capturedCache) {
      const existing = await readJson<CapturedSnapshot>($, paths.capturedPath)
      state.capturedCache = {
        tools: existing?.tools ?? {},
        skills: existing?.skills ?? {},
      }
    }
    const bucket = state.capturedCache[kind]
    let dirty = false
    for (const item of updates) {
      if (bucket[item.name]?.hash === item.hash) continue
      bucket[item.name] = { hash: item.hash, chars: item.text.length, text: item.text }
      dirty = true
    }
    if (!dirty) return
    try {
      await $.fs.write(paths.capturedPath, JSON.stringify(state.capturedCache, null, 2))
    } catch {
      // Ignore snapshot write failures; never block normal session flow.
    }
  })
  state.writeChain = task.catch(() => {})
  await task
}

function notifyIfDrifted($: EngineInterface, state: RuntimeState, label: string): void {
  state.driftedNames.add(label)
  if (state.driftedNames.size > state.lastDriftToastCount) {
    state.lastDriftToastCount = state.driftedNames.size
    $.ui.toast(
      `cc-simplify: ${state.driftedNames.size} description(s) changed since warmup — run /cc-simplify:warmup`,
    )
  }
}

async function slimSkillListing(
  $: EngineInterface,
  state: RuntimeState,
  text: string,
): Promise<string> {
  const markerIdx = text.indexOf(SKILL_LIST_MARKER)
  if (markerIdx === -1) return text

  const cfg = await loadConfig($, state)
  const excluded = new Set(cfg?.exclude?.skills ?? [])
  const skillMap = cfg?.skills ?? {}

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const prefix = text.slice(0, markerIdx)
  const rest = text.slice(markerIdx)
  const lines = rest.split(/\r?\n/)

  const capturedUpdates: Array<{ name: string; text: string; hash: string }> = []
  const pending: Array<{
    start: number
    end: number
    name: string
    hash: string
    original: string
    summary: string
  }> = []

  // Skip leading blank lines after the marker, then scan until the bullet list ends.
  let i = 1
  while (i < lines.length && lines[i]?.trim() === '') i++

  while (i < lines.length) {
    const line = lines[i]
    if (!line || !line.startsWith('- ')) break
    const match = line.match(/^- ([^\r\n]+?): (.+)$/)
    const name = match?.[1]
    const firstDesc = match?.[2]
    if (!name || !firstDesc) {
      i++
      continue
    }

    const start = i
    let end = i
    const descLines = [firstDesc]
    while (end + 1 < lines.length) {
      const nextLine = lines[end + 1]
      if (!nextLine || nextLine.startsWith('- ') || /^#+\s/.test(nextLine)) break
      descLines.push(nextLine)
      end++
    }
    i = end + 1

    const original = descLines.join('\n')
    const entry = skillMap[name]

    // Idempotent: skip already-slimmed text so re-runs never overwrite captured/stored originals.
    if (entry && original === entry.summary) continue

    const currentHash = hashText(original)
    capturedUpdates.push({ name, text: original, hash: currentHash })

    if (excluded.has(name) || !entry) continue
    if (entry.hash !== currentHash) {
      notifyIfDrifted($, state, `skill:${name}`)
      continue
    }

    pending.push({
      start,
      end,
      name,
      hash: currentHash,
      original,
      summary: entry.summary,
    })
  }

  await recordCaptured($, state, 'skills', capturedUpdates)

  if (pending.length === 0) return text

  const saved = await Promise.all(
    pending.map(item => persistDoc($, skillKey(item.name), item.hash, item.original)),
  )

  let changed = false
  for (let idx = pending.length - 1; idx >= 0; idx--) {
    const item = pending[idx]
    if (!saved[idx] || !item) continue
    lines.splice(item.start, item.end - item.start + 1, `- ${item.name}: ${item.summary}`)
    changed = true
  }

  return changed ? prefix + lines.join(eol) : text
}

async function readVerifiedDoc(
  $: EngineInterface,
  state: RuntimeState,
  cfg: SlimConfig | null,
  kind: 'tool' | 'skill',
  name: string,
): Promise<string | undefined> {
  if (state.driftedNames.has(`${kind}:${name}`)) return undefined
  const excluded = kind === 'tool' ? cfg?.exclude?.tools : cfg?.exclude?.skills
  if (excluded?.includes(name)) return undefined
  const entry = kind === 'tool' ? cfg?.tools?.[name] : cfg?.skills?.[name]
  if (!entry) return undefined
  const v = await $.store.get(kind === 'tool' ? toolKey(name) : skillKey(name))
  if (!v || typeof v !== 'object') return undefined
  const { hash, text } = v as Partial<StoredDoc>
  return hash === entry.hash && typeof text === 'string' ? text : undefined
}

async function listVerifiedLabels(
  $: EngineInterface,
  state: RuntimeState,
  cfg: SlimConfig | null,
): Promise<string[]> {
  const candidates: Array<{ kind: 'tool' | 'skill'; name: string }> = [
    ...Object.keys(cfg?.tools ?? {}).map(name => ({ kind: 'tool' as const, name })),
    ...Object.keys(cfg?.skills ?? {}).map(name => ({ kind: 'skill' as const, name })),
  ]
  const verified = await Promise.all(
    candidates.map(async c =>
      (await readVerifiedDoc($, state, cfg, c.kind, c.name)) !== undefined
        ? `${c.kind}:${c.name}`
        : null,
    ),
  )
  return verified.filter((x): x is string => x !== null).sort()
}

async function lookupDoc(
  $: EngineInterface,
  state: RuntimeState,
  cfg: SlimConfig | null,
  rawTarget: string,
): Promise<string | undefined> {
  const target = rawTarget.trim()
  if (!target) return undefined
  if (target.startsWith('tool:')) return readVerifiedDoc($, state, cfg, 'tool', target.slice(5))
  if (target.startsWith('skill:')) return readVerifiedDoc($, state, cfg, 'skill', target.slice(6))
  return (
    (await readVerifiedDoc($, state, cfg, 'tool', target)) ??
    (await readVerifiedDoc($, state, cfg, 'skill', target))
  )
}

export const register: Register = on => {
  const state: RuntimeState = {
    configPromise: null,
    capturedCache: null,
    writeChain: Promise.resolve(),
    notifiedUnwarmed: false,
    driftedNames: new Set<string>(),
    lastDriftToastCount: 0,
  }

  // Guide user to run warmup when no local slim list exists yet.
  on('session.start', async ($, e, next) => {
    const cfg = await loadConfig($, state)
    if (!hasAnySlimEntry(cfg) && !state.notifiedUnwarmed) {
      state.notifiedUnwarmed = true
      $.ui.toast('cc-simplify: not warmed up yet — run /cc-simplify:warmup to build your slim list')
    }
    return next(e)
  })

  // Reload slim.json and refresh engine caches on /clear so warmup edits apply immediately.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      state.configPromise = null
      state.notifiedUnwarmed = false
      state.driftedNames.clear()
      state.lastDriftToastCount = 0
      $.ui.invalidate('tool.list')
      $.ui.invalidate('tool.describe')
      $.ui.invalidate('prompt.attachment')
    }
    return next(e)
  })

  // Keep all tools intact; append read-only get_doc only when a warmed slim list is active.
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined) return listed
    const cfg = await loadConfig($, state)
    if (!hasAnySlimEntry(cfg)) return listed
    if (listed.value.some(t => t.name === DOC_TOOL_NAME)) return listed

    return {
      value: [
        ...listed.value,
        {
          name: DOC_TOOL_NAME,
          description:
            'Return full original documentation for slimmed built-in tools or skill listing entries. Pass targets like ["tool:Workflow", "skill:dataviz"] or bare names.',
          mcp: false,
          isReadOnly: true,
          isConcurrencySafe: true,
          isDeferred: false,
          inputSchema: {
            type: 'object',
            properties: {
              targets: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'One or more names, e.g. ["Workflow", "Monitor"] or prefixed ["tool:PowerShell", "skill:dataviz"].',
              },
            },
            required: ['targets'],
          },
        },
      ],
    }
  }).catch(($, e, next) => next(e))

  // Capture all core tool descriptions and slim those whose hash matches slim.json.
  on('tool.describe', async ($, e, next) => {
    const res = await next(e)
    if (e.tool === DOC_TOOL_NAME || e.provider?.tier !== 'core' || !res.description) {
      return res
    }
    // Pass through if a downstream plugin modified the description.
    if (res.description !== e.description) return res

    const currentHash = hashText(res.description)
    await recordCaptured($, state, 'tools', [{ name: e.tool, text: res.description, hash: currentHash }])

    const cfg = await loadConfig($, state)
    if (!cfg) return res
    if (cfg.exclude?.tools?.includes(e.tool)) return res

    const entry = cfg.tools?.[e.tool]
    if (!entry || res.description === entry.summary) return res

    if (entry.hash !== currentHash) {
      notifyIfDrifted($, state, `tool:${e.tool}`)
      return res
    }

    const ok = await persistDoc($, toolKey(e.tool), currentHash, res.description)
    if (!ok) return res

    return { ...res, description: entry.summary }
  })

  // Slim warmed skill entries in both system prompt sections and skill_listing attachments.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    let changed = false
    const sections = await Promise.all(
      res.sections.map(async section => {
        if (!section.text.includes(SKILL_LIST_MARKER)) return section
        const nextText = await slimSkillListing($, state, section.text)
        if (nextText === section.text) return section
        changed = true
        return { ...section, text: nextText }
      }),
    )
    return changed ? { ...res, sections } : res
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const res = await next(e)
    if (!res.text || !res.text.includes(SKILL_LIST_MARKER)) return res
    const nextText = await slimSkillListing($, state, res.text)
    return nextText === res.text ? res : { ...res, text: nextText }
  })

  // Serve persisted originals via exact tool.call matcher; pass through if unwarmed.
  on('tool.call', { tool: DOC_TOOL_MATCH }, async ($, e, next) => {
    const cfg = await loadConfig($, state)
    if (!hasAnySlimEntry(cfg)) return next(e)

    const raw = (e as Record<string, unknown>).targets
    const targets = Array.isArray(raw)
      ? raw.map(v => String(v))
      : typeof raw === 'string'
        ? [raw]
        : []

    if (targets.length === 0) {
      const available = await listVerifiedLabels($, state, cfg)
      return {
        result: `Specify targets: string[]. Available slimmed docs: ${available.join(', ') || '(none)'}`,
      }
    }

    const blocks: string[] = []
    let hadMissing = false
    for (const target of targets) {
      const doc = await lookupDoc($, state, cfg, target)
      if (doc !== undefined) {
        blocks.push(`# ${target}\n\n${doc}`)
      } else {
        hadMissing = true
        blocks.push(`# ${target}\n\n(No slimmed doc stored for "${target}".)`)
      }
    }

    if (hadMissing) {
      const available = await listVerifiedLabels($, state, cfg)
      blocks.push(`Available slimmed docs: ${available.join(', ') || '(none)'}`)
    }

    return { result: blocks.join('\n\n---\n\n') }
  }).catch(() => ({ result: 'Failed to read stored documentation.' }))
}
