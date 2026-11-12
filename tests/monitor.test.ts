import type { AgentInfo, AgentSpawnInput, On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildDetail, clampLines, toolSummary, TIMELINE_CAP } from '../hooks/detail'
import {
  agentLabel,
  allTokensOf,
  effortLevel,
  estimateUsd,
  filledCells,
  firstTimestamp,
  formatElapsed,
  formatTokens,
  formatUsd,
  modelName,
  modelShort,
  percentOf,
  projectKey,
  windowFor,
} from '../hooks/format'
import { ACTIVITY_MAX, endActivity, feedRows, labelFor, pushActivity } from '../hooks/activity'
import { addLink, buildGraph, layout, resolveRecipient } from '../hooks/graph'
import { drawGraph, treeLines } from '../hooks/map'
import { buildRows, rowStateOf, sections } from '../hooks/rows'
import type { Row } from '../hooks/rows'
import { DESKTOP } from '../hooks/theme'

const PLUGIN = 'subagent-monitor'
const SURFACES = ['terminal', 'desktop'] as const
const SCROLL = { offset: 0, bodyRows: 40 }
const PANE = {
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'subagents',
  props: { title: 'Subagents', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: SCROLL, view: {} },
}
const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: SCROLL, view: {} },
}
const HAIKU = 'claude-haiku-4-5-20251001'
const RUN = {
  command: 'subagents',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

type World = {
  list: AgentInfo[]
  isPaneUp: boolean
  isPlaced?: boolean
  placeOnOpen?: boolean
  usd?: number
  files?: Record<string, string>
  messages?: Record<string, SessionMessage[] | { deny: string }>
  reads?: number
  opens?: number
}

/** The world beneath the plugin: its agent list, a session that cost $1.234, its panes, transcripts. */
const engine = (on: On, world: World, now = 1_000_000) => {
  const clock = mock.clock(on, { now })
  const slashed = (path: string) => path.replaceAll('\\', '/')
  on('agent.list', () => ({ value: world.list }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [],
      cost: { usd: world.usd ?? 1.234 },
    },
  }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.panes', () => ({
    value: world.isPaneUp
      ? [{ id: 'subagents', title: 'Subagents', isShown: true, isFocused: false, isPlaced: world.isPlaced ?? true }]
      : [],
  }))
  on('ui.open', () => {
    world.opens = (world.opens ?? 0) + 1
    world.isPaneUp = true
    world.isPlaced = world.placeOnOpen ?? true

    return {
      value: world.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no surface yet' },
    }
  })
  on('ui.close', () => {
    world.isPaneUp = false

    return { value: undefined }
  })
  on('agent.spawn', (_$, e) => ({ model: HAIKU, agentId: e.workflow ? 'w1' : 'a1' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: {
        model: e.model,
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 44_000,
      },
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:\\proj' }))
  on('fs.exists', (_$, e) => ({
    value: slashed(e.path) in (world.files ?? {}) || slashed(e.path).endsWith('/subagents'),
  }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    const text = world.files?.[slashed(e.path)]

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('session.messages', (_$, e) => {
    world.reads = (world.reads ?? 0) + 1
    const id = 'agentId' in e ? e.agentId : undefined

    return { value: world.messages?.[id ?? ''] ?? { deny: `no conversation for ${id}` } }
  })

  return clock
}

const running: AgentInfo = { id: 'a1', description: 'scan repo', type: 'Explore', status: 'running', name: 'scout' }

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'tu1',
  prompt: 'scan',
  description: 'scan repo',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
}

/** One model request through the chain, drained. */
const step = async ($: Engine, model: string, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, effort: 'high', messageCount: 1, ...(agentId && { agentId }) })
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

const use = (id: string, tool: string, input: Record<string, unknown>, text?: string, isError?: true) => ({
  tool_use_id: id,
  tool,
  input,
  ...(text !== undefined && { text }),
  ...(isError && { isError }),
})

const CONVERSATION: SessionMessage[] = [
  { role: 'user', text: 'Map every endpoint.\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8', toolUses: [] },
  {
    role: 'assistant',
    text: 'Looking at the routes first.',
    toolUses: [
      use('u1', 'Read', { file_path: 'C:/repo/src/routes.ts' }, 'ok'),
      use('u2', 'Bash', { command: 'npm test', description: 'Run the unit tests' }, 'boom', true),
    ],
  },
  { role: 'assistant', text: '', toolUses: [use('u3', 'Grep', { pattern: 'app\\.get\\(' })] },
]

// ---- Pure helpers ----------------------------------------------------------------

test('number, time and model formats follow the handoff', () => {
  expect(formatTokens(1_240_000)).toBe('1.24M')
  expect(formatTokens(2_000_000)).toBe('2M')
  expect(formatTokens(86_400)).toBe('86.4k')
  expect(formatTokens(121_000)).toBe('121k')
  expect(formatTokens(850)).toBe('850')
  expect(formatUsd(0.71)).toBe('$0.71')
  expect(formatElapsed(252_000)).toBe('4m 12s')
  expect(formatElapsed(185_000)).toBe('3m 05s')
  expect(formatElapsed(58_000)).toBe('58s')
  expect(formatElapsed(3_720_000)).toBe('1h 02m')
  expect(modelName(HAIKU)).toBe('Haiku 4.5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  expect(modelName('haiku')).toBe('Haiku')
  expect(modelShort('claude-opus-5-5')).toBe('Opus')
  expect(effortLevel('low')).toBe(1)
  expect(effortLevel('max')).toBe(5)
  expect(effortLevel(undefined)).toBe(0)
  expect(agentLabel({ name: 'scout', description: 'scan repo', type: 'Explore' })).toBe('scan repo')
})

test('cost estimates use list prices per model', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(estimateUsd(HAIKU, usage)).toBe(1)
  expect(estimateUsd('claude-opus-5-5', { ...usage, input_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(0.2)
  expect(estimateUsd('claude-sonnet-4-6', { ...usage, input_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBe(3.75)
  expect(estimateUsd('gpt-x', usage)).toBeUndefined()
  expect(allTokensOf({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })).toBe(10)
})

test('context window: the session window on the main model, else an estimate', () => {
  expect(windowFor('claude-opus-5-5', 'claude-opus-5-5', 1_000_000)).toEqual({ tokens: 1_000_000, isEstimate: false })
  expect(windowFor('claude-opus-5-5[1m]', 'claude-opus-5-5', 200_000)).toEqual({ tokens: 1_000_000, isEstimate: true })
  expect(windowFor(HAIKU, 'claude-opus-5-5', 1_000_000)).toEqual({ tokens: 200_000, isEstimate: true })
  expect(percentOf(45_200, 200_000)).toBe(23)
  expect(filledCells(50, 10)).toBe(5)
})

test('transcript helpers', () => {
  expect(firstTimestamp('{"type":"user","timestamp":"1970-01-01T00:15:40.000Z"}\n{"timestamp":"x"}')).toBe(940_000)
  expect(firstTimestamp('{"type":"user"}')).toBeUndefined()
  expect(projectKey('C:\\Users\\dev')).toBe('C--Users-dev')
})

test('rows: done subagents stay after the engine drops them; quiet workflow agents and forks do not show', () => {
  const base = { startedAt: 0, touchedAt: 100_000, type: 'Explore', description: 'map' }
  const known = {
    gone: { ...base, isSubagent: true, endedAt: 90_000, outcome: 'completed' as const },
    w1: { ...base, workflowRunId: 'wf_1' },
    fork: { startedAt: 0, touchedAt: 100_000 },
  }
  expect(buildRows([], known, 120_000).map(row => [row.id, row.state, row.isLive])).toEqual([
    ['w1', 'running', true],
    ['gone', 'done', false],
  ])
  expect(buildRows([], known, 161_000).map(row => row.id)).toEqual(['gone'])
  expect(rowStateOf('completed', 'failed')).toBe('failed')
})

test('sections: live rows latest start first, finished rows latest end first, unknown times last', () => {
  const at = (id: string, isLive: boolean, startedAt?: number, endedAt?: number) => ({ id, isLive, startedAt, endedAt })
  const { live, finished } = sections([
    at('old', true, 10),
    at('f-mid', false, 0, 50),
    at('anon', true),
    at('new', true, 30),
    at('f-late', false, 0, 90),
    at('f-anon', false, 5),
  ])
  expect(live.map(one => one.id)).toEqual(['new', 'old', 'anon'])
  expect(finished.map(one => one.id)).toEqual(['f-late', 'f-mid', 'f-anon'])

  // A row's end: its recorded end, else its last sign of life; none while live.
  const known = {
    a: { startedAt: 0, touchedAt: 70_000, isSubagent: true, endedAt: 40_000, outcome: 'completed' as const },
    b: { startedAt: 0, touchedAt: 60_000, isSubagent: true },
  }
  expect(buildRows([], known, 100_000).map(one => [one.id, one.startedAt, one.endedAt])).toEqual([
    ['a', 0, 40_000],
    ['b', 0, 60_000],
  ])
})

test('detail: prompt, a timeline of tool calls and words, the last words as the result', () => {
  const detail = buildDetail(CONVERSATION)
  expect(detail.prompt).toStartWith('Map every endpoint.')
  expect(detail.timeline).toEqual([
    { kind: 'text', id: 't1', text: 'Looking at the routes first.' },
    { kind: 'tool', id: 'u1', tool: 'Read', summary: 'C:/repo/src/routes.ts', status: 'ok' },
    { kind: 'tool', id: 'u2', tool: 'Bash', summary: 'Run the unit tests', status: 'error' },
    { kind: 'tool', id: 'u3', tool: 'Grep', summary: 'app\\.get\\(', status: 'running' },
  ])
  expect(detail.result).toBe('Looking at the routes first.')
  const many = buildDetail([
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: Array.from({ length: 40 }, (_, i) => use(`x${i}`, 'Read', { file_path: `f${i}` }, 'ok')) },
  ])
  expect(many.timeline).toHaveLength(TIMELINE_CAP)
  expect(many.hidden).toBe(10)
  expect(toolSummary('WebFetch', { url: 'https://x.y' })).toBe('https://x.y')
  expect(clampLines('a\nb\nc', 2, 40)).toEqual({ text: 'a\nb…', isCut: true })
})

// ---- The pane ----------------------------------------------------------------------

test('the list shows the summary and an agent row with model, effort, tokens, cost and context', async ($, on) => {
  const world: World = { list: [running], isPaneUp: true }
  const clock = engine(on, world)

  await $.agent.spawn(SPAWN)
  await step($, HAIKU, 'a1')
  await clock.advance(65_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: '$1.23' })).toBeDefined()
    else expect((await ui.findAll({ type: 'Svg' })).some(one => one.props.alt === '$1.23')).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'SESSION TOTAL · API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Subagents \$0\.01/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ key: 'tile-Cache read' })).toBeDefined()
    const card = await ui.find({ key: 'agent-a1' })
    expect(card?.text).toContain('scan repo')
    expect(card?.text).toContain('Explore · 1m 05s')
    expect(card?.text).toContain('Haiku 4.5')
    expect(card?.text).toContain('high')
    expect(card?.text).toContain('45.3k tok')
    expect(card?.text).toContain('$0.01')
    expect(card?.text).toMatch(/45\.2k \/ ~200k · ~23%/)
    await ui.unmount()
  }
})

test('desktop draws bars as clipped filled SVGs, an SVG effort meter, two hairlines, no own close', async ($, on) => {
  engine(on, { list: [running], isPaneUp: true })
  await $.agent.spawn(SPAWN)
  await step($, HAIKU, 'a1')

  /** A bar part: a zero-basis, clipping Box growing by its share, painted by one wide filled SVG. */
  const part = async (ui: { find: (q: { key: string }) => Promise<{ props: Record<string, unknown>; children: unknown[] } | undefined> }, key: string) => {
    const box = await ui.find({ key })
    const fill = box?.children.find(
      (child): child is { type: string; props: Record<string, unknown> } =>
        typeof child === 'object' && child !== null && (child as { type?: string }).type === 'Svg',
    )

    return { props: box?.props, source: String(fill?.props.source), height: fill?.props.height }
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // No line glyphs on the desktop: its proportional face draws them as hairlines.
  expect(await ui.find({ type: 'Text', text: /[━─]/ })).toBeUndefined()
  // The context bar: 23 of 100 filled in the context colour, the rest the track colour, 4px tall.
  const filled = await part(ui, 'ctx-bar-0')
  expect(filled.props).toMatchObject({ flexGrow: 23, width: 0, minWidth: 0, overflow: 'hidden' })
  expect(filled.source).toContain('fill="#6EA8FE"')
  expect(filled.source).toContain('width="4000" height="4"')
  expect(filled.height).toBe(4)
  const track = await part(ui, 'ctx-bar-1')
  expect(track.props).toMatchObject({ flexGrow: 77, width: 0, overflow: 'hidden' })
  expect(track.source).toContain('fill="#2A2A31"')
  // The split bar: main thread then subagents, 6px tall, 2px apart.
  expect((await part(ui, 'split-0')).source).toContain('fill="#ECECEE"')
  expect((await part(ui, 'split-1')).source).toContain('height="6"')
  expect((await ui.find({ key: 'split-0-gap' }))?.props).toMatchObject({ width: 0.25, flexShrink: 0 })
  // Borders only under the header and the summary: 1px, border colour.
  expect((await part(ui, 'rule-header-0')).source).toContain('height="1"')
  expect((await part(ui, 'rule-summary-0')).source).toContain('fill="#2A2A31"')
  // Effort: the 5-segment SVG meter, 3 segments lit for high.
  const meter = (await ui.findAll({ type: 'Svg' })).find(one => one.props.alt === 'effort 3 of 5')
  expect(String(meter?.props.source)).toContain('width="3" height="7.5"')
  // The desktop pane chrome has its own close: no second one inside.
  expect(await ui.find({ key: 'close' })).toBeUndefined()
  await ui.unmount()

  // The terminal keeps glyph bars and its own compact close.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /━+─+/ })).toBeDefined()
  const close = await term.find({ key: 'close' })
  expect(close?.text).toBe('×')
  expect(close?.props).toMatchObject({ role: 'dismiss', label: 'Close panel' })
  await term.unmount()
})

test('a subagent on the main model gets the session window, not an estimate', async ($, on) => {
  engine(on, { list: [running], isPaneUp: true })

  await step($, 'claude-opus-5-5')
  await step($, 'claude-opus-5-5', 'a1')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'agent-a1' }))?.text).toMatch(/45\.2k \/ 200k · 23%/)
  await ui.unmount()
})

test('a finished agent keeps its row, its elapsed time frozen, after the engine drops it', async ($, on) => {
  const world: World = { list: [running], isPaneUp: true }
  const clock = engine(on, world)

  await $.agent.spawn(SPAWN)
  await clock.advance(10_000)
  await $.turn.complete({ answer: 'done', durationMs: 10_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  world.list = []
  await clock.advance(30_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'agent-a1' }))?.text).toContain('Explore · 10s')
  expect(await ui.find({ type: 'Text', text: /0 running/ })).toBeDefined()
  await ui.unmount()
})

test('a workflow agent, never in the agent list, gets a row from its events', async ($, on) => {
  const clock = engine(on, { list: [], isPaneUp: true })

  await $.agent.spawn({ ...SPAWN, description: 'map modules', workflow: { runId: 'wf_1', agentIndex: 1 } })
  await step($, HAIKU, 'w1')
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const card = await ui.find({ key: 'agent-w1' })
  expect(card?.text).toContain('map modules')
  expect(card?.text).toContain('5s')
  await ui.unmount()
})

test('an agent started before the mod loaded takes its start from its transcript', async ($, on) => {
  const world: World = {
    list: [{ ...running, id: 'a9' }],
    isPaneUp: true,
    files: { 'C:/home/.claude/projects/C--proj/s1/subagents/agent-a9.jsonl': '{"timestamp":"1970-01-01T00:15:40.000Z"}\n' },
  }
  const clock = engine(on, world)
  mock.env(on, { USERPROFILE: 'C:/home' })

  await step($, HAIKU, 'a9')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const card = await ui.find({ key: 'agent-a9' })
  expect(card?.text).toContain('1m 00s')
  expect(card?.text).not.toContain('≥')
  await ui.unmount()
})

test('cost and tokens follow each response', async ($, on) => {
  const world: World = { list: [], isPaneUp: true }
  engine(on, world, 5_000_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  world.usd = 2.5
  await step($, 'claude-opus-5-5')
  expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '45.3k' })).toBeDefined()
  world.usd = 3
  await step($, 'claude-opus-5-5')
  expect(await ui.find({ type: 'Text', text: '$3.00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '90.5k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No subagents running' })).toBeDefined()
  await ui.unmount()
})

test('the list puts live agents first and the finished ones after a rule, under FINISHED with their count', async ($, on) => {
  const world: World = {
    list: [
      { ...running, id: 'a2', description: 'old job', type: 'Plan', status: 'completed' },
      running,
      { ...running, id: 'a3', description: 'broke', status: 'failed' },
    ],
    isPaneUp: true,
  }
  engine(on, world)
  await $.agent.spawn(SPAWN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const live = (await ui.find({ key: 'list' }))?.text
    expect(live).toContain('scan repo')
    expect(live).not.toContain('old job')
    expect(live).not.toContain('broke')
    const done = (await ui.find({ key: 'finished-list' }))?.text
    expect(done).toContain('old job')
    expect(done).toContain('broke')
    expect(done).not.toContain('scan repo')
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('FINISHED · 2')
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ key: 'no-running' })).toBeUndefined()

    // Document order: the live row, then the rule and the label, then the finished rows.
    const boxes = (await ui.findAll({ type: 'Box' })).map(one => one.key)
    const at = (key: string) => boxes.indexOf(key)
    expect(at('agent-a1')).toBeGreaterThanOrEqual(0)
    expect(at('agent-a1')).toBeLessThan(at('finished-label'))
    expect(at('finished-label')).toBeLessThan(at('agent-a2'))
    expect(at('finished-label')).toBeLessThan(at('agent-a3'))

    // The rule sits between the live row and the label, on both surfaces.
    const rule = await ui.find({ key: 'finished-rule' })
    expect(rule).toBeDefined()
    expect(at('agent-a1')).toBeLessThan(at('finished-rule'))
    expect(at('finished-rule')).toBeLessThan(at('finished-label'))
    if (surface === 'terminal') {
      // The terminal separates with a full-width line of `─` and a text label.
      expect(rule?.text).toBe('─'.repeat(PANE.props.bodyColumns))
    } else {
      // The desktop: a full-width 1px hairline in the border colour.
      const fill = (await ui.find({ key: 'finished-rule-0' }))?.children.find(
        (child): child is { type: string; props: Record<string, unknown> } =>
          typeof child === 'object' && child !== null && (child as { type?: string }).type === 'Svg',
      )
      expect(String(fill?.props.source)).toContain('height="1"')
      expect(String(fill?.props.source)).toContain('fill="#2A2A31"')
    }
    await ui.unmount()
  }
})

test('with no finished agent the list has no FINISHED section', async ($, on) => {
  engine(on, { list: [running], isPaneUp: true })
  await $.agent.spawn(SPAWN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ key: 'finished-rule' })).toBeUndefined()
    expect(await ui.find({ key: 'finished-label' })).toBeUndefined()
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /FINISHED/ })).toBeUndefined()
    expect(await ui.find({ key: 'no-running' })).toBeUndefined()
    await ui.unmount()
  }
})

test('with only finished agents the live section says No agents running', async ($, on) => {
  engine(on, { list: [{ ...running, status: 'completed' }], isPaneUp: true })
  await $.agent.spawn(SPAWN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'no-running' }))?.text).toContain('No agents running')
    expect((await ui.find({ key: 'list' }))?.text).not.toContain('scan repo')
    expect(await ui.find({ key: 'empty' })).toBeUndefined()
    expect(await ui.find({ key: 'finished-rule' })).toBeDefined()
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('FINISHED · 1')
    expect((await ui.find({ key: 'finished-list' }))?.text).toContain('scan repo')
    await ui.unmount()
  }
})

// ---- Folding the sections ---------------------------------------------------------------

/** One live agent (a1) and two finished ones (a2, a3). */
const MIXED: AgentInfo[] = [
  { ...running, id: 'a2', description: 'old job', type: 'Plan', status: 'completed' },
  running,
  { ...running, id: 'a3', description: 'broke', status: 'failed' },
]

test('a click on the AGENTS head folds the live rows behind ▸ and unfolds them again', async ($, on) => {
  const clock = engine(on, { list: MIXED, isPaneUp: true })
  await $.agent.spawn(SPAWN)

  for (const surface of SURFACES) {
    let ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▾ AGENTS')
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

    await ui.press({ key: 'toggle-live' })
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▸ AGENTS')
    expect(await ui.find({ key: 'list' })).toBeUndefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
    // The summary stays at the head's right; the finished section is untouched.
    expect((await ui.find({ key: 'list-head' }))?.text).toMatch(/1 running · 2 done/)
    expect((await ui.find({ key: 'finished-list' }))?.text).toContain('old job')
    expect((await ui.find({ key: 'toggle-finished' }))?.text).toContain('▾ FINISHED · 2')

    // A redraw (the ticker's) and a fresh mount both keep the fold.
    await clock.advance(1_000)
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▸ AGENTS')
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()

    await ui.press({ key: 'toggle-live' })
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▾ AGENTS')
    expect((await ui.find({ key: 'list' }))?.text).toContain('scan repo')
    await ui.unmount()
  }
})

test('a folded live section hides its notes too', async ($, on) => {
  const world: World = { list: [], isPaneUp: true }
  engine(on, world)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'empty' })).toBeDefined()
    await ui.press({ key: 'toggle-live' })
    expect(await ui.find({ key: 'empty' })).toBeUndefined()
    expect((await ui.find({ key: 'list-head' }))?.text).toMatch(/0 running · 0 done/)
    await ui.press({ key: 'toggle-live' })
    await ui.unmount()
  }

  world.list = [{ ...running, status: 'completed' }]
  await $.agent.spawn(SPAWN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'no-running' })).toBeDefined()
    await ui.press({ key: 'toggle-live' })
    expect(await ui.find({ key: 'no-running' })).toBeUndefined()
    expect((await ui.find({ key: 'finished-list' }))?.text).toContain('scan repo')
    await ui.press({ key: 'toggle-live' })
    await ui.unmount()
  }
})

test('a click on the FINISHED head folds its rows, keeping the rule and the label; detail and Back keep it', async ($, on) => {
  const clock = engine(on, { list: MIXED, isPaneUp: true })
  await $.agent.spawn(SPAWN)

  for (const surface of SURFACES) {
    let ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'toggle-finished' })
    expect(await ui.find({ key: 'finished-rule' })).toBeDefined()
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('▸ FINISHED · 2')
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()
    expect(await ui.find({ key: 'agent-a2' })).toBeUndefined()
    expect(await ui.find({ key: 'agent-a3' })).toBeUndefined()
    // The live section stays open.
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▾ AGENTS')
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

    await clock.advance(1_000)
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('▸ FINISHED · 2')

    // A row still opens its detail, and Back returns to the list as it was folded.
    await ui.press({ key: 'open-a1' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()

    await ui.press({ key: 'toggle-finished' })
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('▾ FINISHED · 2')
    expect((await ui.find({ key: 'finished-list' }))?.text).toContain('old job')
    await ui.unmount()
  }
})

test('the folds are kept in the store and read back when a session starts', async ($, on) => {
  mock.store(on, { collapsed: { live: true, finished: true } })
  engine(on, { list: MIXED, isPaneUp: false })
  await $.agent.spawn(SPAWN)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▸ AGENTS')
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('▸ FINISHED · 2')
    expect(await ui.find({ key: 'list' })).toBeUndefined()
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a malformed stored fold is ignored: both sections open', async ($, on) => {
  mock.store(on, { collapsed: { live: 'yes' } })
  engine(on, { list: MIXED, isPaneUp: false })
  await $.agent.spawn(SPAWN)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'toggle-live' }))?.text).toContain('▾ AGENTS')
  expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
  expect(await ui.find({ key: 'finished-list' })).toBeDefined()
  await ui.unmount()
})

test('each fold is written to the store', async ($, on) => {
  const saved: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: saved[e.key] }))
  on('store.set', (_$, e) => {
    saved[e.key] = e.value

    return { value: undefined }
  })
  engine(on, { list: MIXED, isPaneUp: true })
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-live' })
  expect(saved.collapsed).toEqual({ live: true, finished: false, map: false })
  await ui.press({ key: 'toggle-finished' })
  expect(saved.collapsed).toEqual({ live: true, finished: true, map: false })
  await ui.press({ key: 'toggle-live' })
  expect(saved.collapsed).toEqual({ live: false, finished: true, map: false })
  await ui.press({ key: 'toggle-map' })
  expect(saved.collapsed).toEqual({ live: false, finished: true, map: true })
  await ui.unmount()
})

// ---- Detail ------------------------------------------------------------------------

test('a row opens its detail: prompt with Show more, live timeline, Back returns to the list', async ($, on) => {
  const world: World = { list: [running], isPaneUp: true, messages: { a1: CONVERSATION } }
  const clock = engine(on, world)
  await $.agent.spawn(SPAWN)
  await step($, HAIKU, 'a1')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-a1' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect((await ui.find({ key: 'prompt' }))?.text).not.toContain('line 8')
    await ui.press({ key: 'prompt-more' })
    expect((await ui.find({ key: 'prompt' }))?.text).toContain('line 8')
    const activity = await ui.find({ key: 'activity' })
    expect(activity?.text).toContain('Read C:/repo/src/routes.ts')
    expect(activity?.text).toContain('Bash Run the unit tests')
    expect(activity?.text).not.toContain('WebSearch')

    // Live: a new call shows once the 2 s throttle has passed.
    world.messages = {
      a1: [...CONVERSATION, { role: 'assistant', text: '', toolUses: [use('u4', 'WebSearch', { query: 'abp routes' })] }],
    }
    await clock.advance(2_000)
    expect((await ui.find({ key: 'activity' }))?.text).toContain('WebSearch abp routes')

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    world.messages = { a1: CONVERSATION }
    await ui.unmount()
  }
})

test('a finished agent shows its result; closing the pane returns to the list', async ($, on) => {
  const world: World = { list: [{ ...running, status: 'completed' }], isPaneUp: true, messages: { a1: CONVERSATION } }
  engine(on, world)
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-a1' })
  expect((await ui.find({ key: 'result' }))?.text).toContain('Looking at the routes first.')
  // Closed by a click on the band (the desktop chrome's × is the engine's; the kit cannot raise it).
  const strip = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await strip.press({ key: 'subagents-band' })
  await strip.unmount()
  expect(world.isPaneUp).toBe(false)
  await ui.unmount()

  world.isPaneUp = true
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ key: 'agent-a1' })).toBeDefined()
  expect(await again.find({ key: 'back' })).toBeUndefined()
  await again.unmount()
})

test('an agent whose conversation the session cannot read shows a note, not an error', async ($, on) => {
  const world: World = { list: [running], isPaneUp: true }
  engine(on, world)
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open-a1' })
  const note = await ui.find({ key: 'unavailable' })
  expect(note?.text).toContain('Details unavailable')
  expect(note?.text).toContain('no conversation for a1')
  await ui.unmount()
})

// ---- The band and the toggles ----------------------------------------------------------

test('the band shows every agent and the totals, and a click toggles the pane', async ($, on) => {
  const world: World = { list: [running], isPaneUp: false }
  engine(on, world)
  await $.agent.spawn(SPAWN)
  await step($, HAIKU, 'a1')

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const text = (await band.find({ key: 'subagents-band' }))?.text ?? ''
    expect(text).toContain('AGENTS')
    expect(text).toContain('Explore · Haiku')
    expect(text).toContain('23%')
    expect(text).toContain('45.3k tok')
    expect(text).toContain('$1.23')
    await band.press({ key: 'subagents-band' })
    expect(world.isPaneUp).toBe(true)
    await band.press({ key: 'subagents-band' })
    expect(world.isPaneUp).toBe(false)
    await band.unmount()
  }
})

test('/subagents toggles the pane; one waiting undrawn counts as closed', async ($, on) => {
  const world: World = { list: [running], isPaneUp: false }
  engine(on, world)

  expect((await $.command.run(RUN)).text).toBe('Subagents pane opened.')
  expect(world.isPaneUp).toBe(true)
  expect((await $.command.run(RUN)).text).toBe('Subagents pane closed.')

  world.placeOnOpen = false
  await $.command.run(RUN)
  expect(world.isPlaced).toBe(false)
  world.placeOnOpen = true
  expect((await $.command.run(RUN)).text).toBe('Subagents pane opened.')
  expect(world.isPlaced).toBe(true)
})

// ---- The first typed prompt seats the pane -------------------------------------------

/** A prompt the person typed at an idle session: asked, so its open is placed at any width. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('the first typed prompt seats a pane session.start left undrawn, and passes through unchanged', async ($, on) => {
  const world: World = { list: [], isPaneUp: false, placeOnOpen: false }
  engine(on, world)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(world.isPaneUp).toBe(true)
  expect(world.isPlaced).toBe(false)
  expect(world.opens).toBe(1)

  world.placeOnOpen = true
  const text = 'Map every endpoint.\n  keep   spacing  '
  const entered = await $.prompt.submit(typed(text))
  expect(entered.drop).toBeUndefined()
  expect('text' in entered && entered.text).toBe(text)
  expect(world.opens).toBe(2)
  expect(world.isPlaced).toBe(true)
})

test('a later prompt never reopens the pane, even when it waits undrawn again', async ($, on) => {
  const world: World = { list: [], isPaneUp: true, isPlaced: false }
  engine(on, world)
  await $.prompt.submit(typed('one'))
  expect(world.opens).toBe(1)

  // Only the once flag stands between this prompt and another open.
  world.isPlaced = false
  const entered = await $.prompt.submit(typed('two'))
  expect('text' in entered && entered.text).toBe('two')
  expect(world.opens).toBe(1)
})

test('a queued prompt or one from elsewhere does not spend the once', async ($, on) => {
  const world: World = { list: [], isPaneUp: true, isPlaced: false }
  engine(on, world)
  await $.prompt.submit({ ...typed('mid-turn'), turnId: 't0' })
  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  expect(world.opens ?? 0).toBe(0)

  await $.prompt.submit(typed('mine'))
  expect(world.opens).toBe(1)
})

test('after the person closes the pane, a prompt leaves it closed', async ($, on) => {
  // By the command (the band and the pane's own close share its path).
  const world: World = { list: [], isPaneUp: false }
  engine(on, world)
  await $.command.run(RUN)
  await $.command.run(RUN)
  expect(world.isPaneUp).toBe(false)
  const before = world.opens
  const entered = await $.prompt.submit(typed('hello'))
  expect('text' in entered && entered.text).toBe('hello')
  expect(world.opens).toBe(before)
  expect(world.isPaneUp).toBe(false)

  // The command still toggles it either way.
  expect((await $.command.run(RUN)).text).toBe('Subagents pane opened.')
})

test('after a click on the band closes the pane, a prompt leaves it closed', async ($, on) => {
  const world: World = { list: [], isPaneUp: true, isPlaced: true }
  engine(on, world)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'subagents-band' })
  await band.unmount()
  expect(world.isPaneUp).toBe(false)

  await $.prompt.submit(typed('hello'))
  expect(world.opens ?? 0).toBe(0)
  expect(world.isPaneUp).toBe(false)
})

// ---- The map ------------------------------------------------------------------------

type RowOpts = { isLive?: boolean; endedAt?: number; parentId?: string; name?: string }

/** A pane row as buildRows makes one, its record carrying the map's fields. */
const rowOf = (id: string, opts: RowOpts = {}): Row => {
  const isLive = opts.isLive ?? true

  return {
    id,
    label: id,
    type: 'Explore',
    state: isLive ? 'running' : 'done',
    isLive,
    isWorkflow: false,
    record: {
      startedAt: 0,
      touchedAt: 0,
      isSubagent: true,
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    },
    elapsedMs: 0,
    startedAt: 0,
    endedAt: isLive ? undefined : (opts.endedAt ?? 0),
  }
}

/** Each node as [id, parent, depth]. */
const shape = (rows: Row[]) => buildGraph(rows, {}, null, 0).nodes.map(node => [node.id, node.parent, node.depth])

test('graph: a spawn chain gives depth 1, 2, 3', () => {
  const g = buildGraph([rowOf('a'), rowOf('b', { parentId: 'a' }), rowOf('c', { parentId: 'b' })], {}, 'claude-opus-5-5', 0)
  expect(g.nodes.map(node => [node.id, node.parent, node.depth])).toEqual([
    ['main', null, 0],
    ['a', 'main', 1],
    ['b', 'a', 2],
    ['c', 'b', 3],
  ])
  expect(g.nodes[0]).toMatchObject({ label: 'MAIN', state: 'root', model: 'claude-opus-5-5' })
  expect(g.edges).toEqual([
    { kind: 'spawn', from: 'main', to: 'a', count: 1 },
    { kind: 'spawn', from: 'a', to: 'b', count: 1 },
    { kind: 'spawn', from: 'b', to: 'c', count: 1 },
  ])
  expect(g.hidden).toBe(0)
})

test('graph: an unknown parent attaches to main', () => {
  expect(shape([rowOf('a', { parentId: 'ghost' }), rowOf('b', { parentId: 'b' })])).toEqual([
    ['main', null, 0],
    ['a', 'main', 1],
    ['b', 'main', 1],
  ])
})

test('graph: a parent cycle attaches to main', () => {
  expect(shape([rowOf('a', { parentId: 'b' }), rowOf('b', { parentId: 'a' }), rowOf('c', { parentId: 'a' })])).toEqual([
    ['main', null, 0],
    ['a', 'main', 1],
    ['b', 'main', 1],
    ['c', 'a', 2],
  ])
})

test('graph: a finished agent leaves the map and its live child attaches to main', () => {
  const rows = [rowOf('lead', { isLive: false, endedAt: 10 }), rowOf('kid', { parentId: 'lead' }), rowOf('other')]
  const g = buildGraph(rows, {}, null, 0)
  expect(g.nodes.map(node => [node.id, node.parent, node.depth])).toEqual([
    ['main', null, 0],
    ['kid', 'main', 1],
    ['other', 'main', 1],
  ])
  expect(g.hidden).toBe(0)

  // Labels: the agent's name, else its type, cut at 12.
  const named = buildGraph([rowOf('n', { name: 'a-very-long-agent-name' }), rowOf('t')], {}, null, 0)
  expect(named.nodes.map(node => node.label)).toEqual(['MAIN', 'a-very-long…', 'Explore'])
})

test('graph: more live agents than max are counted hidden', () => {
  const busy = buildGraph([rowOf('x'), rowOf('done', { isLive: false, endedAt: 1 }), rowOf('y'), rowOf('z')], {}, null, 0, 2)
  expect(busy.nodes.map(node => node.id)).toEqual(['main', 'x', 'y'])
  expect(busy.hidden).toBe(1)
})

test('graph: a message edge needs both ends on the map', () => {
  let links = addLink({}, 'main', 'a', 1)
  links = addLink(links, 'a', 'b', 2)
  links = addLink(links, 'a', 'b', 3)
  links = addLink(links, 'b', 'gone', 4)
  links = addLink(links, 'ghost', 'a', 5)
  links = addLink(links, 'a', 'late', 9_000)
  const rows = [rowOf('a'), rowOf('b'), rowOf('gone', { isLive: false, endedAt: 1 }), rowOf('late')]
  const g = buildGraph(rows, links, null, 10_000)
  expect(g.edges.filter(edge => edge.kind === 'message')).toEqual([
    { kind: 'message', from: 'a', to: 'b', count: 2, lastAt: 3, isFresh: false },
    { kind: 'message', from: 'a', to: 'late', count: 1, lastAt: 9_000, isFresh: true },
    { kind: 'message', from: 'main', to: 'a', count: 1, lastAt: 1, isFresh: false },
  ])
  expect(g.hidden).toBe(0)
})

test('links: resolveRecipient matches id, then name, preferring the latest start', () => {
  const known = {
    a1: { startedAt: 10, touchedAt: 10, name: 'scout' },
    a2: { startedAt: 50, touchedAt: 50, name: 'scout' },
    a3: { startedAt: 20, touchedAt: 20 },
  }
  const list: AgentInfo[] = [
    { id: 'a3', description: 'x', type: 'Explore', status: 'running', name: 'lead', teammateId: 'lead@team' },
    { id: 'scout', description: 'y', type: 'Explore', status: 'running' },
  ]
  expect(resolveRecipient('a1', known, list)).toBe('a1')
  // An id wins over a name, even one spelled like it.
  expect(resolveRecipient('scout', known, list)).toBe('scout')
  expect(resolveRecipient('scout', known, [])).toBe('a2')
  expect(resolveRecipient('lead', known, list)).toBe('a3')
  expect(resolveRecipient('lead@team', known, list)).toBe('a3')
  expect(resolveRecipient('nobody', known, list)).toBeUndefined()
  expect(resolveRecipient('', known, list)).toBeUndefined()

  // The live list's names come before the recorded ones: a2 asked for `scout`, the team gave it `scout-2`.
  const suffixed = { a1: { startedAt: 10, touchedAt: 10, name: 'scout' }, a2: { startedAt: 50, touchedAt: 50, name: 'scout' } }
  const team: AgentInfo[] = [
    { id: 'a1', description: 'x', type: 'teammate', status: 'idle', name: 'scout' },
    { id: 'a2', description: 'y', type: 'teammate', status: 'idle', name: 'scout-2' },
  ]
  expect(resolveRecipient('scout', suffixed, team)).toBe('a1')
  expect(resolveRecipient('scout-2', suffixed, team)).toBe('a2')
})

test('links: addLink counts repeats and drops the oldest past max', () => {
  let links = addLink({}, 'main', 'a', 1)
  links = addLink(links, 'main', 'a', 5)
  expect(links).toEqual({ 'main>a': { from: 'main', to: 'a', count: 2, lastAt: 5 } })
  expect(addLink(links, 'a', 'a', 6)).toBe(links)

  let few = addLink({}, 'x', 'a', 1, 2)
  few = addLink(few, 'x', 'b', 2, 2)
  few = addLink(few, 'x', 'a', 3, 2)
  few = addLink(few, 'x', 'c', 4, 2)
  expect(Object.keys(few).sort()).toEqual(['x>a', 'x>c'])
  expect(few['x>a']?.count).toBe(2)
})

/** MAIN -> lead -> b (c finished, off the map); MAIN messaged lead twice, lead messaged b once. */
const mapGraph = (now: number) => {
  let links = addLink({}, 'main', 'a', 1_000)
  links = addLink(links, 'main', 'a', 2_000)
  links = addLink(links, 'a', 'b', 2_500)

  return buildGraph(
    [rowOf('a', { name: 'lead' }), rowOf('b', { parentId: 'a' }), rowOf('c', { isLive: false, endedAt: 5 })],
    links,
    'claude-opus-5-5',
    now,
  )
}

test('map: drawGraph draws one circle group per node and one path per message edge', () => {
  const g = mapGraph(3_000)
  const svg = drawGraph(g, DESKTOP, 410)
  expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="410" height="342" viewBox="0 0 360 300">')
  expect((svg.match(/data-node="/g) ?? []).length).toBe(3)
  expect((svg.match(/data-edge="message"/g) ?? []).length).toBe(2)
  expect((svg.match(/data-edge="spawn"/g) ?? []).length).toBe(2)
  // A message in the last 3 s flies a pulse; the root says MAIN and its model.
  expect(svg).toContain('<animateMotion')
  expect(svg).toContain('>MAIN</text>')
  expect(svg).toContain('>Opus 5.5</text>')
  expect(drawGraph(mapGraph(60_000), DESKTOP, 410)).not.toContain('<animateMotion')

  // The terminal: the spawn tree, then the message pairs.
  expect(treeLines(g)).toEqual([
    'MAIN · Opus 5.5',
    '└─ lead · running',
    '   └─ Explore · running',
    'lead → Explore ×1',
    'MAIN → lead ×2',
  ])
})

test('map: drawGraph is identical for the same graph a second later', () => {
  // No fresh links: nothing time-derived may reach the source, so the desktop never redraws the image.
  expect(drawGraph(mapGraph(10_000), DESKTOP, 410)).toBe(drawGraph(mapGraph(11_000), DESKTOP, 410))
  expect(drawGraph(mapGraph(10_000), DESKTOP, 410)).toContain('begin="0s" repeatCount="indefinite"')
  expect(drawGraph(mapGraph(10_000), DESKTOP, 410)).not.toMatch(/begin="-/)
})

test('map: drawGraph escapes labels', () => {
  const svg = drawGraph(buildGraph([rowOf('<id>', { name: '<b>&"q' })], {}, null, 0), DESKTOP, 360)
  expect(svg).toContain('&lt;b&gt;&amp;&quot;q')
  expect(svg).toContain('data-node="&lt;id&gt;"')
  expect(svg).not.toContain('<b>')
})

test('layout: root is centred and every node is inside the box', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => rowOf(`a${i}`)),
    ...Array.from({ length: 8 }, (_, i) => rowOf(`b${i}`, { parentId: `a${i % 3}` })),
    ...Array.from({ length: 6 }, (_, i) => rowOf(`c${i}`, { parentId: `b${i}` })),
    rowOf('d0', { parentId: 'c0' }),
  ]
  const g = buildGraph(rows, {}, null, 0)
  const spots = layout(g, 360, 300)
  expect(spots).toHaveLength(g.nodes.length)
  expect(spots[0]).toEqual({ id: 'main', x: 180, y: 150 })
  for (const spot of spots) {
    expect(spot.x - 13).toBeGreaterThanOrEqual(0)
    expect(spot.x + 13).toBeLessThanOrEqual(360)
    expect(spot.y - 13).toBeGreaterThanOrEqual(0)
    expect(spot.y + 13).toBeLessThanOrEqual(300)
  }
  // The first slice starts at the top and runs clockwise.
  expect(spots[1]?.x ?? 0).toBeGreaterThan(180)
  // Same input, same picture.
  expect(layout(g, 360, 300)).toEqual(spots)
})

test('collapsed: a stored pair without map restores with map open', async ($, on) => {
  mock.store(on, { collapsed: { live: false, finished: true } })
  engine(on, { list: MIXED, isPaneUp: false })
  await $.agent.spawn(SPAWN)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-map' }))?.text).toContain('▾ MAP')
    expect(await ui.find({ key: 'map-body' })).toBeDefined()
    expect((await ui.find({ key: 'finished-label' }))?.text).toContain('▸ FINISHED · 2')
    expect(await ui.find({ key: 'finished-list' })).toBeUndefined()
    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).some(one => one.props.alt === 'Agent map')).toBe(true)
    }
    await ui.press({ key: 'toggle-map' })
    expect((await ui.find({ key: 'toggle-map' }))?.text).toContain('▸ MAP')
    expect(await ui.find({ key: 'map-body' })).toBeUndefined()
    await ui.press({ key: 'toggle-map' })
    await ui.unmount()
  }
})

test('session.send: a delivered message from a subagent to a named agent adds a link', async ($, on) => {
  const helper: AgentInfo = { ...running, id: 'a2', description: 'help out', name: 'helper', parentId: 'a1' }
  const clock = engine(on, { list: [running, helper], isPaneUp: true })
  let isDelivered = true
  on('session.send', () => (isDelivered ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'gone' }))
  await $.agent.spawn({ ...SPAWN, name: 'scout' })
  // The ticker fills the helper's name and parent from the list.
  await clock.advance(1_000)

  const sent = await $.session.send({ to: 'scout', text: 'secret plan', origin: { kind: 'model' }, agentId: 'a2' })
  expect(sent.isDelivered).toBe(true)
  // Refused: no link. To nobody known: no link.
  isDelivered = false
  await $.session.send({ to: 'scout', text: 'again', origin: { kind: 'model' }, agentId: 'a2' })
  isDelivered = true
  await $.session.send({ to: 'nobody', text: 'hi', origin: { kind: 'model' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'map-head' }))?.text).toContain('2 running · 1 links')
  const body = (await ui.find({ key: 'map-body' }))?.text ?? ''
  expect(body).toContain('└─ scout · running')
  // The helper hangs from scout, which spawned it.
  expect(body.indexOf('└─ helper · running')).toBeGreaterThan(body.indexOf('└─ scout · running'))
  expect(body).toContain('helper → scout ×1')
  expect(body).not.toContain('secret plan')
  await ui.unmount()
})

// ---- What each subagent is doing ---------------------------------------------------------

test('activity: labelFor never returns a command line or a query string', () => {
  expect(labelFor('Bash', { command: 'curl -H "Authorization: Bearer s3cret" https://x.y/?q=1' })).toBe('curl')
  expect(labelFor('Bash', { command: 'TOKEN=s3cret git push origin main' })).toBe('git')
  expect(labelFor('PowerShell', { command: 'Get-Secret -Name db', description: 'Read the db secret name' })).toBe(
    'Read the db secret name',
  )
  expect(labelFor('WebFetch', { url: 'https://user:pw@example.com:8080/a/b?token=s3cret#x', prompt: 'p' })).toBe(
    'example.com:8080',
  )
  expect(labelFor('WebSearch', { query: 'private question' })).toBe('web search')
  expect(labelFor('Grep', { pattern: 'password=' })).toBe('Grep')
  expect(labelFor('Read', { file_path: 'C:\\repo\\src\\routes.ts' })).toBe('src/routes.ts')
  expect(labelFor('Agent', { description: 'map modules', prompt: 'long secret prompt' })).toBe('map modules')
  expect(labelFor('SendMessage', { to: 'scout', message: 'hi' })).toBe('→ scout')
  expect(labelFor('Skill', { skill: 'review' })).toBe('review')
  expect(labelFor('mcp__my_server__do_thing', { arg: 'x' })).toBe('my server: do thing')
  expect(labelFor('Bash', {})).toBe('Bash')
  expect(labelFor('Bash', { description: `line\u0007one\nline two ${'x'.repeat(60)}` })).toHaveLength(48)
  expect(labelFor('Bash', { description: 'a\u0007b\nc' })).toBe('a b c')
})

test('activity: the list is capped at 40', () => {
  let list = Array.from({ length: 45 }, (_, i) => i + 1).reduce(
    (all, id) => pushActivity(all, { id, agentId: 'a1', tool: 'Read', label: 'x', startedAt: id, status: 'run' }),
    [] as ReturnType<typeof pushActivity>,
  )
  expect(list).toHaveLength(ACTIVITY_MAX)
  expect(list[0]?.id).toBe(6)
  list = endActivity(list, 45, 'err', 50)
  expect(list[39]).toMatchObject({ id: 45, status: 'err', endedAt: 50 })

  // The feed: running calls first, then each agent's last finished one; agents off the map left out.
  const feed = feedRows(
    [
      { id: 1, agentId: 'a1', tool: 'Read', label: 'old', startedAt: 0, endedAt: 1_000, status: 'ok' },
      { id: 2, agentId: 'a1', tool: 'Bash', label: 'npm', startedAt: 2_000, endedAt: 5_000, status: 'err' },
      { id: 3, agentId: 'a1', tool: 'Grep', label: 'Grep', startedAt: 6_000, status: 'run' },
      { id: 4, agentId: 'gone', tool: 'Read', label: 'x', startedAt: 6_000, status: 'run' },
    ],
    new Map([['a1', 'scout']]),
    9_000,
  )
  expect(feed.map(row => `${row.mark} ${row.agent}  ${row.tool}  ${row.label}  ${row.tail}`)).toEqual([
    '● scout  Grep  Grep  running',
    '✕ scout  Bash  npm  3s',
  ])
})

test('activity: a subagent tool call shows as running then with its duration', async ($, on) => {
  const clock = engine(on, { list: [running], isPaneUp: true })
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = () => resolve()
  })
  let enter = () => {}
  const entered = new Promise<void>(resolve => {
    enter = () => resolve()
  })
  on('tool.call', async () => {
    enter()
    await gate

    return { result: 'ok', text: 'ok' }
  })
  await $.agent.spawn(SPAWN)

  // Built apart from the call: `agentId` is the engine's, beside the tool's own arguments.
  const input = { tool: 'Bash' as const, command: 'curl -H "Authorization: s3cret" https://x.y', agentId: 'a1' }
  const call = $.tool.call(input)
  await entered
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const during = (await term.find({ key: 'map-feed' }))?.text ?? ''
  expect(during).toMatch(/Bash\s+curl\s+running/)
  expect(during).not.toContain('s3cret')
  await term.unmount()

  await clock.advance(2_000)
  release()
  await call
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The feed is Text under the map, not part of its SVG.
  expect((await ui.find({ key: 'map-feed' }))?.text).toMatch(/Bash\s+curl\s+2s/)
  const map = (await ui.findAll({ type: 'Svg' })).find(one => one.props.alt === 'Agent map')
  expect(String(map?.props.source)).not.toContain('curl')
  await ui.unmount()
})

test('activity: a main-loop tool call is not recorded', async ($, on) => {
  engine(on, { list: [running], isPaneUp: true })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'map-body' })).toBeDefined()
  expect(await ui.find({ key: 'map-feed' })).toBeUndefined()
  await ui.unmount()
})
