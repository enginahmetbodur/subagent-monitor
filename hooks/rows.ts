// What the pane lists, folded from the engine's agent list and the mod's own
// records. Pure, so it is tested directly.

import type { AgentInfo, AgentStatus } from 'claude-code'

import type { SubagentMonitorAgent, SubagentMonitorAgents } from '../types'
import { agentLabel, isActive } from './format'

/** A workflow agent (never in `$.agent.list()`) counts as running this long after its last request. */
export const QUIET_MS = 60_000

/** The state a row shows, the engine's status folded with how its run ended. */
export type RowState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'idle'

export const rowStateOf = (status: AgentStatus | undefined, outcome: string | undefined): RowState => {
  if (status === 'running') return 'running'
  if (status === 'pending' || status === 'waiting') return 'waiting'
  if (status === 'failed' || outcome === 'failed') return 'failed'
  if (status === 'killed' || outcome === 'aborted') return 'stopped'
  if (status === 'idle') return 'idle'

  return 'done'
}

export type Row = {
  id: string
  label: string
  type: string
  state: RowState
  isLive: boolean
  isWorkflow: boolean
  record: SubagentMonitorAgent | undefined
  /** Undefined when the mod never saw it start. */
  elapsedMs: number | undefined
}

const elapsedOf = (record: SubagentMonitorAgent | undefined, isLive: boolean, now: number) => {
  if (record === undefined) return undefined
  // A finished agent whose end the mod missed: its last sign of life is the closest end.
  const end = record.endedAt ?? (isLive ? now : record.touchedAt)

  return Math.max(0, end - record.startedAt)
}

/**
 * The engine's listed agents, then the subagents it no longer lists (it drops a
 * finished one after a while; the handoff keeps done rows) and workflow agents
 * (never listed). Running rows first.
 */
export const buildRows = (list: readonly AgentInfo[], known: SubagentMonitorAgents, now: number): Row[] => {
  const listed = list.map((agent): Row => {
    const record = known[agent.id]
    const isLive = isActive(agent.status)

    return {
      id: agent.id,
      label: agentLabel(agent),
      type: agent.type,
      state: rowStateOf(agent.status, record?.outcome),
      isLive,
      isWorkflow: false,
      record,
      elapsedMs: elapsedOf(record, isLive, now),
    }
  })

  const listedIds = new Set(list.map(agent => agent.id))
  const unlisted = Object.entries(known).flatMap(([id, record]): Row[] => {
    const isWorkflow = record.workflowRunId !== undefined
    if (listedIds.has(id) || !(record.isSubagent || isWorkflow)) return []

    // A workflow agent runs while its requests keep coming; a quiet one is left out until it speaks again.
    const isLive = isWorkflow && record.endedAt === undefined
    if (isLive && now - record.touchedAt > QUIET_MS) return []

    return [
      {
        id,
        label: record.description || record.type || 'agent',
        type: record.type ?? 'agent',
        state: isLive ? 'running' : rowStateOf(undefined, record.outcome ?? 'completed'),
        isLive,
        isWorkflow,
        record,
        elapsedMs: elapsedOf(record, isLive, now),
      },
    ]
  })

  const all = [...listed, ...unlisted]

  return [...all.filter(row => row.isLive), ...all.filter(row => !row.isLive)]
}
