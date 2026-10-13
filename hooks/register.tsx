import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, ModelUsage, Register, SessionUsage, Timer } from 'claude-code'

import type { SubagentMonitorAgent, SubagentMonitorAgents, SubagentMonitorTotals, SubagentMonitorView } from '../types'
import { buildDetail } from './detail'
import {
  allTokensOf,
  contextTokensOf,
  estimateUsd,
  firstTimestamp,
  formatEffort,
  isActive,
  projectKey,
  windowFor,
} from './format'
import { buildRows } from './rows'
import type { Row } from './rows'
import { band, detailPane, kitFor, listPane } from './view'
import type { Actions, AgentView, DetailState, SummaryView } from './view'

const PANE = 'subagents'
const TITLE = 'Subagents'
const MAX_RECORDS = 200
const REFRESH_MS = 2000
const DETAIL_MS = 2000

const ZERO: SubagentMonitorTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const LIST_VIEW: SubagentMonitorView = { agentId: null, isPromptOpen: false, isResultOpen: false }

const agents = atom({ plugin: 'subagent-monitor', key: 'agents' } as const, {})
const totals = atom({ plugin: 'subagent-monitor', key: 'totals' } as const, ZERO)
const isOpen = atom({ plugin: 'subagent-monitor', key: 'isOpen' } as const, null)
const mainModel = atom({ plugin: 'subagent-monitor', key: 'mainModel' } as const, null)
const view = atom({ plugin: 'subagent-monitor', key: 'view' } as const, LIST_VIEW)

type Patch = Partial<Omit<SubagentMonitorAgent, 'touchedAt'>>

/** A read that never throws: a render that throws closes the pane. */
const safe = async <T,>(work: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work()
  } catch {
    return fallback
  }
}

/** Keeps the newest records; finished ones go first. */
const prune = (all: SubagentMonitorAgents): SubagentMonitorAgents => {
  const entries = Object.entries(all)
  if (entries.length <= MAX_RECORDS) return all

  const rank = ([, a]: [string, SubagentMonitorAgent]) => (a.endedAt === undefined ? 1 : 0)
  entries.sort((x, y) => rank(y) - rank(x) || y[1].touchedAt - x[1].touchedAt)

  return Object.fromEntries(entries.slice(0, MAX_RECORDS))
}

/** Merges a patch (or one computed from the record) into an agent's record, creating it if new. */
async function record(
  $: EngineInterface,
  id: string,
  patch: Patch | ((known: SubagentMonitorAgent) => Patch),
): Promise<SubagentMonitorAgent | undefined> {
  const now = await $.clock.now()
  const all = await update($, agents, current => {
    const known = current[id] ?? { startedAt: now, isApproximate: true, touchedAt: now }
    const change = typeof patch === 'function' ? patch(known) : patch

    return prune({ ...current, [id]: { ...known, ...change, touchedAt: now } })
  })

  return all[id]
}

// ---- Start times of agents the mod did not see spawn -------------------------
// No API carries an agent's start time ($.session.messages rows have no
// timestamp), but its transcript's first line does:
// <config>/projects/<project key>/<session id>/subagents/agent-<id>.jsonl

const startLookups = new Set<string>()
let subagentsDir: string | undefined

async function findSubagentsDir($: EngineInterface): Promise<string | undefined> {
  if (subagentsDir !== undefined) return subagentsDir

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (config === undefined) return undefined

  const sessionId = await $.session.id()
  const projects = `${config}/projects`
  const guess = `${projects}/${projectKey(await $.session.root())}/${sessionId}/subagents`
  if (await $.fs.exists(guess)) return (subagentsDir = guess)

  // The root moved (/cd, a worktree): find the folder holding this session.
  for (const entry of await $.fs.list(projects)) {
    const dir = `${projects}/${entry.name}/${sessionId}/subagents`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) return (subagentsDir = dir)
  }

  return undefined
}

/** Once per agent and load: replaces a first-seen start with the transcript's first timestamp. */
async function resolveStart($: EngineInterface, id: string): Promise<void> {
  if (startLookups.has(id)) return
  startLookups.add(id)

  const dir = await findSubagentsDir($)
  if (dir === undefined) return
  // Rejects past 4 MiB: that agent keeps its approximate start.
  const startedAt = firstTimestamp(await $.fs.read(`${dir}/agent-${id}.jsonl`))
  if (startedAt === undefined) return

  await update($, agents, current => {
    const one = current[id]

    return one === undefined ? current : { ...current, [id]: { ...one, startedAt, isApproximate: false } }
  })
}

// ---- One agent's detail, kept in module memory only -----------------------------

let detailCache: { id: string; at: number; isFinal: boolean; value: DetailState } | undefined

/** Reads the agent's conversation at most every DETAIL_MS while it runs, once more when it ends. */
async function fetchDetail($: EngineInterface, id: string, isLive: boolean, isWorkflow: boolean): Promise<DetailState> {
  const now = await $.clock.now()
  const cached = detailCache?.id === id ? detailCache : undefined
  if (cached && (cached.isFinal || (isLive && now - cached.at < DETAIL_MS))) return cached.value

  let value: DetailState
  if (isWorkflow) {
    value = { kind: 'unavailable', reason: 'A workflow keeps its agents’ conversations under its own run.' }
  } else {
    const found = await $.session.messages({ agentId: id })
    value = 'deny' in found ? { kind: 'unavailable', reason: found.deny } : { kind: 'ready', detail: buildDetail(found) }
  }
  detailCache = { id, at: now, isFinal: !isLive, value }

  return value
}

// ---- Redraws ------------------------------------------------------------------

/** Whether the pane is open AND drawn: an unasked open may wait undrawn until a surface seats it. */
async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
}

// Cost and context move with every response; redraw at most once per REFRESH_MS,
// with one trailing redraw so the last response is never left out.
let lastRefreshAt = 0
let trailing: Timer | null = null

async function refreshSoon($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const wait = lastRefreshAt + REFRESH_MS - now
  if (wait <= 0) {
    lastRefreshAt = now
    $.ui.invalidate('ui.render')
  } else if (trailing === null) {
    trailing = $.clock.after(wait, () => {
      trailing = null
      lastRefreshAt += REFRESH_MS
      $.ui.invalidate('ui.render')
    })
  }
}

// One 1s ticker per module load; a hot reload drops it, so every hook that
// sees activity re-arms it. It keeps the open flag true to the screen, marks
// listed agents as subagents, ends the ones that stopped, and redraws the
// pane and the band while anything runs.
let ticker: Timer | null = null

async function tick($: EngineInterface): Promise<void> {
  const isShown = await isPaneShown($)
  if ((await read($, isOpen)) !== isShown) await update($, isOpen, () => isShown)

  const list = await $.agent.list()
  const listed = new Map(list.map(agent => [agent.id, agent]))
  const all = await read($, agents)
  const now = await $.clock.now()

  // Listed agents are subagents; one with no record has run since before the mod loaded.
  for (const agent of list.filter(a => all[a.id]?.isSubagent !== true)) {
    const isNew = all[agent.id] === undefined
    await record($, agent.id, { isSubagent: true, description: agent.description, type: agent.type })
    if (isNew) void resolveStart($, agent.id).catch(() => undefined)
  }

  // An agent can stop without a turn.complete (killed); a listed one that left the
  // list has ended. Workflow agents are never listed: the quiet rule ages them.
  const gone = Object.entries(all)
    .filter(([id, one]) => {
      if (one.endedAt !== undefined) return false
      const agent = listed.get(id)

      return agent === undefined ? one.workflowRunId === undefined && one.isSubagent === true : !isActive(agent.status)
    })
    .map(([id]) => id)
  if (gone.length > 0) {
    await update($, agents, current => {
      const next = { ...current }
      for (const id of gone) {
        const one = next[id]
        if (one !== undefined) next[id] = { ...one, endedAt: now, touchedAt: now }
      }

      return next
    })
  }

  if (list.some(a => isActive(a.status)) || Object.values(all).some(one => one.endedAt === undefined)) {
    $.ui.invalidate('ui.render')
  }
}

function ensureTicker($: EngineInterface): void {
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => void tick($).catch(() => undefined))
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => opened.isPlaced)
  ensureTicker($)
}

async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  await update($, isOpen, () => false)
  await update($, view, () => LIST_VIEW)
}

async function togglePane($: EngineInterface): Promise<void> {
  if (await isPaneShown($)) await closePane($)
  else await openPane($)
}

async function showDetail($: EngineInterface, agentId: string | null): Promise<void> {
  detailCache = undefined
  await update($, view, () => ({ ...LIST_VIEW, agentId }))
}

async function toggleSection($: EngineInterface, section: 'isPromptOpen' | 'isResultOpen'): Promise<void> {
  await update($, view, current => ({ ...current, [section]: !current[section] }))
}

/** Every press the drawing can make, bound to this hook's `$`. */
function actionsFor($: EngineInterface): Actions {
  return {
    close: () => closePane($),
    open: id => showDetail($, id),
    back: () => showDetail($, null),
    togglePrompt: () => toggleSection($, 'isPromptOpen'),
    toggleResult: () => toggleSection($, 'isResultOpen'),
  }
}

// ---- What the drawings show -------------------------------------------------------

type Drawn = { summary: SummaryView; agents: AgentView[]; rows: Row[]; now: number }

/** Folds the engine's figures and the mod's records into the plain data the view draws. */
async function gather($: EngineInterface): Promise<Drawn> {
  const known = await safe(() => read($, agents), {} as SubagentMonitorAgents)
  const sums = await safe(() => read($, totals), ZERO)
  const main = await safe(() => read($, mainModel), null)
  const list = await safe(() => $.agent.list(), [] as AgentInfo[])
  const usage = await safe<SessionUsage | undefined>(() => $.session.usage(), undefined)
  const now = await safe(() => $.clock.now(), 0)

  const rows = buildRows(list, known, now)
  const views = rows.map((row): AgentView => {
    const one = row.record
    const window = windowFor(one?.model, main, usage?.context.window)

    return {
      id: row.id,
      task: row.label,
      type: row.type,
      state: row.state,
      isLive: row.isLive,
      elapsedMs: row.elapsedMs,
      isApproximate: one?.isApproximate === true,
      model: one?.model,
      effort: one?.effort,
      tokens: one?.tokens ?? 0,
      costUsd: one?.costUsd,
      ctxUsed: one?.contextTokens,
      ctxMax: window?.tokens,
      ctxIsEstimate: window?.isEstimate ?? false,
    }
  })

  const subCostUsd = Object.values(known)
    .filter(one => one.isSubagent || one.workflowRunId !== undefined)
    .reduce((sum, one) => sum + (one.costUsd ?? 0), 0)
  const costUsd = usage?.cost?.usd
  const running = rows.filter(row => row.isLive).length

  return {
    summary: {
      costUsd,
      tokens: sums.input + sums.output + sums.cacheRead + sums.cacheWrite,
      mainCostUsd: costUsd === undefined ? undefined : Math.max(0, costUsd - subCostUsd),
      subCostUsd,
      breakdown: sums,
      running,
      done: rows.length - running,
    },
    agents: views,
    rows,
    now,
  }
}

const addUsage = (sum: SubagentMonitorTotals, usage: ModelUsage): SubagentMonitorTotals => ({
  input: sum.input + usage.input_tokens,
  output: sum.output + usage.output_tokens,
  cacheRead: sum.cacheRead + usage.cache_read_input_tokens,
  cacheWrite: sum.cacheWrite + usage.cache_creation_input_tokens,
})

// ---- Hooks --------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ensureTicker($)
    await safe(
      () =>
        $.command.register({
          name: 'subagents',
          description: 'Toggle the Subagents pane (running subagents, session cost)',
        }),
      undefined,
    )
    await safe(async () => {
      const isShown = await isPaneShown($)
      const wanted = await read($, isOpen)
      // First load this session: open once. After that, respect the person's choice.
      if (wanted === null || (wanted && !isShown)) await openPane($)
      else await update($, isOpen, () => isShown)
    }, undefined)

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    // An open pane that waits undrawn counts as closed: the command then seats it.
    const wasShown = await isPaneShown($)
    await togglePane($)

    return { text: wasShown ? 'Subagents pane closed.' : 'Subagents pane opened.' }
  })

  // The engine's own close mark (or ctrl+x x, Esc) closes it too: keep the flag true to
  // the screen, and come back to the list next time.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await safe(async () => {
      await update($, isOpen, () => false)
      await update($, view, () => LIST_VIEW)
    }, undefined)

    return closed
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const id = spawned.agentId
      await safe(async () => {
        await record($, id, {
          startedAt,
          isApproximate: false,
          isSubagent: true,
          model: spawned.model,
          description: e.description,
          type: e.subagentType,
          ...(e.workflow && { workflowRunId: e.workflow.runId }),
        })
        ensureTicker($)
      }, undefined)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  // Every model request: an agent's model and effort on the way down; on the way
  // back its context, tokens and estimated cost, the session's token totals, the
  // main loop's model, and a throttled redraw so the figures follow each response.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id !== undefined) {
      const effort = formatEffort(e.effort)
      const one = await safe(
        () => record($, id, { model: e.model, endedAt: undefined, ...(effort && { effort }) }),
        undefined,
      )
      if (one?.isApproximate) void resolveStart($, id).catch(() => undefined)
      ensureTicker($)
    } else {
      await safe(async () => {
        if ((await read($, mainModel)) !== e.model) await update($, mainModel, () => e.model)
      }, undefined)
    }

    const response = yield* next(e)

    const used = response.usage
    if (used !== null) {
      await safe(() => update($, totals, sum => addUsage(sum, used)), ZERO)
      if (id !== undefined) {
        const cost = estimateUsd(used.model || e.model, used)
        await safe(
          () =>
            record($, id, known => ({
              contextTokens: contextTokensOf(used),
              tokens: (known.tokens ?? 0) + allTokensOf(used),
              ...(cost !== undefined && { costUsd: (known.costUsd ?? 0) + cost }),
            })),
          undefined,
        )
      }
    }
    await safe(() => refreshSoon($), undefined)

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const outcome = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'aborted' : 'failed'
      await safe(async () => record($, id, { endedAt: await $.clock.now(), outcome }), undefined)
    }

    return next(e)
  })

  // The main session's cost and context move after each main-thread turn.
  on('session.measure', ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const drawn = await gather($)
    const k = kitFor($.ui.resolve(e), e.surface, e.props.bodyColumns, drawn.now)
    const actions = actionsFor($)
    const screen = await safe(() => read($, view), LIST_VIEW)

    const index = screen.agentId === null ? -1 : drawn.agents.findIndex(agent => agent.id === screen.agentId)
    const agent = drawn.agents[index]
    const row = drawn.rows[index]
    if (agent === undefined || row === undefined) return listPane(k, drawn.summary, drawn.agents, actions)

    const detail = await safe(() => fetchDetail($, agent.id, agent.isLive, row.isWorkflow), {
      kind: 'unavailable',
      reason: 'Its conversation could not be read.',
    } as DetailState)

    return detailPane(k, agent, detail, { prompt: screen.isPromptOpen, result: screen.isResultOpen }, actions)
  })

  // The band above the prompt: every agent at a glance, and one click to open or close the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const drawn = await gather($)
    const k = kitFor($.ui.resolve(e), e.surface, e.props.bodyColumns, drawn.now)
    const { Box } = $.ui.resolve(e)
    const others = await next(e)

    return (
      <Box flexDirection="column">
        {others}
        {band(k, drawn.summary, drawn.agents, () => togglePane($))}
      </Box>
    )
  })
}
