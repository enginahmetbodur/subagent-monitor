// What each subagent is doing: its recent tool calls as short labels, for the
// feed under the map. Pure, so it is tested directly. A label names what a
// call touches (a file, a host, a tool), never what it carries: no command
// line, no query, no file content.

import type { SubagentMonitorActivity } from '../types'
import { formatElapsed } from './format'

export const ACTIVITY_MAX = 40
const LABEL_MAX = 48

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

const cap = (text: string): string => {
  const clean = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()

  return clean.length <= LABEL_MAX ? clean : `${clean.slice(0, LABEL_MAX - 1)}…`
}

/** `C:\repo\src\a.ts` -> `src/a.ts`. */
const lastTwo = (path: string): string => path.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')

/** The command's first word, skipping `NAME=value` assignments (which may hold a secret). */
const firstWord = (command: string): string =>
  command
    .trim()
    .split(/\s+/)
    .find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? ''

/** `https://user:pw@example.com:8080/p?q=1` -> `example.com:8080`; never the path, query or credentials. */
const hostOf = (url: string): string => {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url.trim())?.[1] ?? ''

  return authority.slice(authority.lastIndexOf('@') + 1)
}

/** A short, content-free label for one call of `tool` with `input`. */
export const labelFor = (tool: string, input: Record<string, unknown>): string => {
  const pick = (): string | undefined => {
    switch (tool) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit': {
        const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)

        return path === undefined ? undefined : lastTwo(path)
      }
      case 'Grep':
      case 'Glob':
        return tool
      case 'Bash':
      case 'PowerShell': {
        const command = str(input.command)

        return str(input.description) ?? (command === undefined ? undefined : firstWord(command))
      }
      case 'WebFetch': {
        const url = str(input.url)

        return url === undefined ? undefined : hostOf(url)
      }
      case 'WebSearch':
        return 'web search'
      case 'Agent':
      case 'Task':
        return str(input.description)
      case 'Skill':
        return str(input.skill) ?? str(input.name)
      case 'SendMessage': {
        const to = str(input.to) ?? str(input.recipient)

        return to === undefined ? undefined : `→ ${to}`
      }
      default: {
        const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
        if (mcp?.[1] !== undefined && mcp[2] !== undefined) {
          return `${mcp[1].replace(/_/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}`
        }

        return tool
      }
    }
  }

  const label = cap(pick() ?? '')

  return label === '' ? cap(tool) : label
}

/** Appends one call; past `max` the oldest go. */
export const pushActivity = (
  list: readonly SubagentMonitorActivity[],
  entry: SubagentMonitorActivity,
  max = ACTIVITY_MAX,
): SubagentMonitorActivity[] => [...list, entry].slice(-Math.max(1, max))

/** Marks call `id` ended with `status`. */
export const endActivity = (
  list: readonly SubagentMonitorActivity[],
  id: number,
  status: SubagentMonitorActivity['status'],
  now: number,
): SubagentMonitorActivity[] => list.map(one => (one.id === id ? { ...one, status, endedAt: now } : one))

export type FeedRow = { key: string; mark: '●' | '·' | '✕'; agent: string; tool: string; label: string; tail: string }

/**
 * The feed: for each agent in `labels` (the agents on the map, by id), its
 * running calls and its last finished one. Running first, newest first.
 */
export const feedRows = (
  list: readonly SubagentMonitorActivity[],
  labels: ReadonlyMap<string, string>,
  now: number,
  max = 8,
): FeedRow[] => {
  const mine = list.filter(one => labels.has(one.agentId))
  const running = mine.filter(one => one.status === 'run')
  const lastDone = new Map<string, SubagentMonitorActivity>()
  for (const one of mine) {
    if (one.status === 'run') continue
    const kept = lastDone.get(one.agentId)
    if (kept === undefined || (one.endedAt ?? one.startedAt) >= (kept.endedAt ?? kept.startedAt)) lastDone.set(one.agentId, one)
  }

  const newest = (a: SubagentMonitorActivity, b: SubagentMonitorActivity) =>
    (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || b.id - a.id
  const shown = [...running.sort((a, b) => b.startedAt - a.startedAt || b.id - a.id), ...[...lastDone.values()].sort(newest)]

  return shown.slice(0, Math.max(0, max)).map(
    (one): FeedRow => ({
      key: `act-${one.id}`,
      mark: one.status === 'run' ? '●' : one.status === 'ok' ? '·' : '✕',
      agent: labels.get(one.agentId) ?? one.agentId,
      tool: one.tool,
      label: one.label,
      tail: one.status === 'run' ? 'running' : formatElapsed(Math.max(0, (one.endedAt ?? now) - one.startedAt)),
    }),
  )
}
