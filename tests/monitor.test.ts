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
import { buildRows, rowStateOf } from '../hooks/rows'

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
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: SCROLL, view: {} },
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
