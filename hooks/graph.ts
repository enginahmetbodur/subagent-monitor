// The map's model: the main loop and its agents as nodes, who spawned whom and
// who messaged whom as edges, and where each node sits. Pure, so it is tested
// directly; no `$` here.

import type { AgentInfo } from 'claude-code'

import type { SubagentMonitorAgents, SubagentMonitorLinks } from '../types'
import type { Row, RowState } from './rows'

/** The main loop's node id, and the `from` of a message the main conversation sent. */
export const ROOT = 'main'

const LABEL_MAX = 12
/** Room kept around the outermost ring for the labels under its nodes. */
const RING_MARGIN = 28
/** Deeper agents share the third ring (inside their own sector). */
const MAX_RING = 3

export type GraphNode = {
  id: string
  label: string
  /** The node it hangs from; null for the root alone. */
  parent: string | null
  depth: number
  state: RowState | 'root'
  isLive: boolean
  model?: string
}

/** A message edge is fresh (it carries a pulse) this long after its latest message. */
export const FRESH_MS = 3000

export type GraphEdge = {
  kind: 'spawn' | 'message'
  from: string
  to: string
  count: number
  lastAt?: number
  /** A message edge used in the last FRESH_MS: the only time-derived fact the map draws. */
  isFresh?: boolean
}

/** Node 0 is the root; `hidden` counts the live agents past `max`. */
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; hidden: number }

export type Placed = { id: string; x: number; y: number }

const short = (text: string): string => (text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`)

/**
 * The live agents, the first `max` in row order; a finished one leaves the
 * map. Each hangs from the agent that spawned it when that one is on the map
 * too, else from the root; a parent chain that loops comes back to the root.
 */
export const buildGraph = (
  rows: readonly Row[],
  links: SubagentMonitorLinks,
  mainModel: string | null,
  now: number,
  max = 24,
): Graph => {
  const live = rows.filter(row => row.id !== ROOT && row.isLive)
  // Row order, so the layout is the same on every draw.
  const kept = live.slice(0, Math.max(0, max))
  const keptIds = new Set(kept.map(row => row.id))

  const parent = new Map<string, string>()
  for (const row of kept) {
    const wanted = row.record?.parentId
    parent.set(row.id, wanted !== undefined && wanted !== row.id && keptIds.has(wanted) ? wanted : ROOT)
  }

  // An agent whose own chain leads back to it is in a loop: it hangs from the root.
  const isInLoop = (id: string): boolean => {
    let at = parent.get(id)
    for (let step = 0; step <= kept.length && at !== undefined && at !== ROOT; step++) {
      if (at === id) return true
      at = parent.get(at)
    }

    return false
  }
  const looped = kept.filter(row => isInLoop(row.id)).map(row => row.id)
  for (const id of looped) parent.set(id, ROOT)

  const depthOf = (id: string): number => {
    let depth = 0
    let at: string | undefined = id
    while (at !== undefined && at !== ROOT && depth <= kept.length) {
      depth++
      at = parent.get(at)
    }

    return depth
  }

  const root: GraphNode = {
    id: ROOT,
    label: 'MAIN',
    parent: null,
    depth: 0,
    state: 'root',
    isLive: true,
    ...(mainModel !== null ? { model: mainModel } : {}),
  }
  const nodes: GraphNode[] = [
    root,
    ...kept.map(
      (row): GraphNode => ({
        id: row.id,
        label: short(row.record?.name ?? row.type),
        parent: parent.get(row.id) ?? ROOT,
        depth: depthOf(row.id),
        state: row.state,
        isLive: row.isLive,
        ...(row.record?.model !== undefined ? { model: row.record.model } : {}),
      }),
    ),
  ]

  const onMap = new Set([ROOT, ...keptIds])
  const spawns = kept.map(
    (row): GraphEdge => ({ kind: 'spawn', from: parent.get(row.id) ?? ROOT, to: row.id, count: 1 }),
  )
  const messages = Object.entries(links)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, link]) => link.from !== link.to && onMap.has(link.from) && onMap.has(link.to))
    .map(
      ([, link]): GraphEdge => ({
        kind: 'message',
        from: link.from,
        to: link.to,
        count: link.count,
        lastAt: link.lastAt,
        isFresh: now - link.lastAt < FRESH_MS,
      }),
    )

  return { nodes, edges: [...spawns, ...messages], hidden: live.length - kept.length }
}

/** The ring spacing: the deepest ring (at most the third) stays `RING_MARGIN` inside the box. */
export const ringStepFor = (g: Graph, w: number, h: number): number => {
  const deepest = Math.min(MAX_RING, Math.max(1, ...g.nodes.map(node => node.depth)))

  return Math.max(0, Math.min(w, h) / 2 - RING_MARGIN) / deepest
}

/**
 * A radial tree: the root at the centre, each agent on the ring of its depth;
 * every subtree gets a slice of its parent's angle in proportion to its leaves,
 * its own node at the slice's middle, the first slice starting at the top.
 */
export const layout = (g: Graph, w: number, h: number): Placed[] => {
  const cx = w / 2
  const cy = h / 2
  const step = ringStepFor(g, w, h)
  const rootId = g.nodes[0]?.id ?? ROOT
  const byId = new Map(g.nodes.map(node => [node.id, node]))
  const children = new Map<string, string[]>()
  for (const node of g.nodes) {
    if (node.parent === null || node.id === rootId) continue
    const kids = children.get(node.parent) ?? []
    kids.push(node.id)
    children.set(node.parent, kids)
  }

  const leafMemo = new Map<string, number>()
  const leavesOf = (id: string, seen: Set<string>): number => {
    const known = leafMemo.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 1
    seen.add(id)
    const kids = children.get(id) ?? []
    const count = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + leavesOf(kid, seen), 0)
    leafMemo.set(id, Math.max(1, count))

    return Math.max(1, count)
  }

  const placed = new Map<string, Placed>([[rootId, { id: rootId, x: cx, y: cy }]])
  const visit = (id: string, start: number, span: number, seen: Set<string>): void => {
    const kids = (children.get(id) ?? []).filter(kid => !seen.has(kid))
    const total = kids.reduce((sum, kid) => sum + leavesOf(kid, new Set()), 0) || 1
    let at = start
    for (const kid of kids) {
      seen.add(kid)
      const share = (span * leavesOf(kid, new Set())) / total
      const angle = at + share / 2
      const radius = Math.min(byId.get(kid)?.depth ?? 1, MAX_RING) * step
      placed.set(kid, { id: kid, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
      visit(kid, at, share, seen)
      at += share
    }
  }
  visit(rootId, -Math.PI / 2, Math.PI * 2, new Set([rootId]))

  return g.nodes.map(node => placed.get(node.id) ?? { id: node.id, x: cx, y: cy })
}

/**
 * The agent a SendMessage `to` names: an agent id as is; else the listed
 * agents whose name or teammate address it is (the list holds a suffixed
 * teammate's real name, `scout-2`); else the recorded names (an agent the list
 * already dropped). Several at one stage: the latest started. Undefined when none.
 */
export const resolveRecipient = (
  to: string,
  known: SubagentMonitorAgents,
  list: readonly AgentInfo[],
): string | undefined => {
  if (to === '') return undefined
  if (known[to] !== undefined || list.some(agent => agent.id === to)) return to

  const latest = (ids: readonly string[]): string | undefined => {
    let best: string | undefined
    let bestAt = Number.NEGATIVE_INFINITY
    for (const id of ids) {
      const at = known[id]?.startedAt ?? Number.NEGATIVE_INFINITY
      if (best === undefined || at > bestAt) {
        best = id
        bestAt = at
      }
    }

    return best
  }

  return (
    latest(list.filter(agent => agent.name === to || agent.teammateId === to).map(agent => agent.id)) ??
    latest(Object.entries(known).flatMap(([id, one]) => (one.name === to ? [id] : [])))
  )
}

/** One more delivered message `from` -> `to`; past `max` pairs the longest-quiet pair goes. */
export const addLink = (
  links: SubagentMonitorLinks,
  from: string,
  to: string,
  now: number,
  max = 100,
): SubagentMonitorLinks => {
  if (from === to) return links
  const key = `${from}>${to}`
  const next: SubagentMonitorLinks = { ...links, [key]: { from, to, count: (links[key]?.count ?? 0) + 1, lastAt: now } }
  const entries = Object.entries(next)
  const room = Math.max(1, max)
  if (entries.length <= room) return next

  entries.sort((a, b) => a[1].lastAt - b[1].lastAt)
  for (const [old] of entries.slice(0, entries.length - room)) delete next[old]

  return next
}
