import type { On, ToolInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { DOC_TOOL_NAME, hashText, type SlimConfig } from './register'

const HOME = 'C:/Users/tester'
const SLIM_PATH = `${HOME}/.claude/cc-simplify/slim.json`
const CAPTURED_PATH = `${HOME}/.claude/cc-simplify/captured.json`

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function setupMockFs(on: On, initialFiles: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [k, v] of Object.entries(initialFiles)) files[norm(k)] = v
  mock.env(on, { USERPROFILE: HOME, HOME })
  on('fs.read', (_, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  return files
}

test('unwarmed session guides user, captures snapshot, and /clear reloads newly written slim.json', async ($, on) => {
  mock.store(on)
  const files = setupMockFs(on, {})
  const toasts: string[] = []
  const invalidated: string[] = []

  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_, e) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.describe', (_, e) => ({ description: e.description }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => t.includes('/cc-simplify:warmup'))).toBe(true)

  const fullWorkflow = 'Full original Workflow instructions with opt-in rules.'
  const res = await $.tool.describe({
    tool: 'Workflow',
    description: fullWorkflow,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(res.description).toBe(fullWorkflow)
  const captured = JSON.parse(files[CAPTURED_PATH] ?? '{}')
  expect(captured.tools.Workflow.hash).toBe(hashText(fullWorkflow))

  // Write slim.json then trigger /clear -> next describe uses new config
  files[SLIM_PATH] = JSON.stringify({
    version: 1,
    tools: { Workflow: { hash: hashText(fullWorkflow), summary: 'Slim Workflow.' } },
  } satisfies SlimConfig)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(invalidated).toContain('tool.list')
  expect(invalidated).toContain('tool.describe')

  const after = await $.tool.describe({
    tool: 'Workflow',
    description: fullWorkflow,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(after.description).toBe('Slim Workflow.')
})

test(
  'tool.list appends get_doc only when slim.json has entries',
  {
    plugins: [
      {
        name: 'probe',
        tier: 'user',
        register(on) {
          on('session.start', async ($, e, next) => {
            const tools = await $.tool.list()
            await $.store.set('tools', tools)
            return next(e)
          })
        },
      },
    ],
  },
  async ($, on) => {
    let listedTools: ToolInfo[] = []
    const cfg: SlimConfig = {
      version: 1,
      tools: { Workflow: { hash: hashText('orig'), summary: 'short' } },
    }
    setupMockFs(on, { [SLIM_PATH]: JSON.stringify(cfg) })
    on('ui.toast', () => ({ value: undefined }))
    on('store.set', (_, e) => {
      if (e.key === 'tools') listedTools = e.value as ToolInfo[]
      return { value: undefined }
    })
    on('tool.list', () => ({
      value: [
        { name: 'Bash', description: 'Run bash', mcp: false },
        { name: 'Workflow', description: 'Run workflow', mcp: false },
      ],
    }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect(listedTools.map(t => t.name)).toEqual(['Bash', 'Workflow', DOC_TOOL_NAME])
    const docTool = listedTools.find(t => t.name === DOC_TOOL_NAME)
    expect(docTool?.mcp).toBe(false)
    expect(docTool?.isReadOnly).toBe(true)
    expect(docTool?.isDeferred).toBe(false)
  },
)

test('warmed tool slims on hash match, skips excluded tools, and blocks stale v1 doc on drift', async ($, on) => {
  const fullWorkflow = 'Full original Workflow instructions with opt-in rules.'
  const fullPowerShell = 'Full PowerShell instructions.'
  const oldMonitor = 'Monitor v1 instructions.'
  const newMonitor = 'Monitor v2 instructions with new safety rule.'
  mock.store(on, {
    'doc:tool:Monitor': { hash: hashText(oldMonitor), text: oldMonitor },
  })
  const toasts: string[] = []

  const cfg: SlimConfig = {
    version: 1,
    exclude: { tools: ['PowerShell'] },
    tools: {
      Workflow: { hash: hashText(fullWorkflow), summary: 'Slim Workflow. Call get_doc.' },
      PowerShell: { hash: hashText(fullPowerShell), summary: 'Should be skipped by exclude.' },
      Monitor: { hash: hashText(oldMonitor), summary: 'Old slim Monitor.' },
    },
  }
  setupMockFs(on, { [SLIM_PATH]: JSON.stringify(cfg) })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.describe', (_, e) => ({ description: e.description }))

  const wf = await $.tool.describe({
    tool: 'Workflow',
    description: fullWorkflow,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(wf.description).toBe('Slim Workflow. Call get_doc.')

  const ps = await $.tool.describe({
    tool: 'PowerShell',
    description: fullPowerShell,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(ps.description).toBe(fullPowerShell)

  const mon = await $.tool.describe({
    tool: 'Monitor',
    description: newMonitor,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(mon.description).toBe(newMonitor)
  expect(toasts.some(t => t.includes('changed since warmup'))).toBe(true)

  const docRes = await $.tool.call({
    tool: DOC_TOOL_NAME,
    targets: ['tool:Workflow', 'tool:Monitor'],
  } as never)
  expect(docRes.result).toContain(fullWorkflow)
  expect(String(docRes.result)).not.toContain(oldMonitor)
})

test('prompt.compose and skill_listing slim warmed single- and multi-line skills idempotently', async ($, on) => {
  mock.store(on)
  const fullClaudeApi = [
    'Reference for the Claude API / Anthropic SDK.',
    'TRIGGER — read FIRST whenever prompt mentions Claude.',
    'SKIP only when another provider is named.',
  ].join('\n')
  const shortClaudeApi = 'Slim Claude API summary preserving TRIGGER and SKIP.'
  const fullPluginSkill = 'Deploy service to staging or production with rollout checks.'
  const shortPluginSkill = 'Deploy service with rollout checks.'
  const customSkill = 'Custom team skill untouched.'

  const cfg: SlimConfig = {
    version: 1,
    skills: {
      'claude-api': { hash: hashText(fullClaudeApi), summary: shortClaudeApi },
      'acme:deploy': { hash: hashText(fullPluginSkill), summary: shortPluginSkill },
    },
  }
  const files = setupMockFs(on, { [SLIM_PATH]: JSON.stringify(cfg) })

  const rawListing = [
    'The following skills are available for use with the Skill tool:',
    '',
    `- claude-api: ${fullClaudeApi.replace(/\n/g, '\r\n')}`,
    '- init',
    `- acme:deploy: ${fullPluginSkill}`,
    `- custom:ops: ${customSkill}`,
    '',
    '- policy: Not a skill entry.',
  ].join('\r\n')

  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const },
      { id: 'skills', text: rawListing, scope: 'session' as const },
    ],
  }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))

  const composed = await $.prompt.compose({
    model: 'test-model',
    promptModel: 'test-model',
    surfaces: ['terminal'],
    tools: ['Skill'],
    outputStyle: null,
    traits: ['skills'],
  })

  const [, skills] = composed.sections
  expect(skills?.text).toContain(`- claude-api: ${shortClaudeApi}`)
  expect(skills?.text).not.toContain('TRIGGER — read FIRST')
  expect(skills?.text).toContain(`- acme:deploy: ${shortPluginSkill}`)
  expect(skills?.text).toContain(`- custom:ops: ${customSkill}`)
  expect(skills?.text).toContain('- policy: Not a skill entry.')
  expect(JSON.parse(files[CAPTURED_PATH] ?? '{}').skills.policy).toBeUndefined()

  // Re-running on slimmed text is idempotent and preserves stored original
  const att = await $.prompt.attachment({
    type: 'skill_listing',
    text: skills?.text ?? '',
    origin: { kind: 'engine' },
  })
  expect(att.text).toBe(skills?.text)

  const docRes = await $.tool.call({
    tool: DOC_TOOL_NAME,
    targets: ['skill:claude-api'],
  } as never)
  expect(docRes.result).toContain('SKIP only when another provider is named.')
})
