/** What the mod remembers about one agent loop, keyed by its agent id. */
export type SubagentMonitorAgent = {
  /** When it started, in `$.clock.now()` ms: `agent.spawn`, its transcript's first line, else first seen. */
  startedAt: number
  /** True while `startedAt` is only when the mod first saw it (spawned before load, transcript unread). */
  isApproximate?: boolean
  /** When its run ended (`turn.complete`, or no longer active in `$.agent.list()`). */
  endedAt?: number
  /** How its last run ended, from `turn.complete`'s reason. */
  outcome?: 'completed' | 'failed' | 'aborted'
  /** The model its latest request named (`turn.step`), else the spawn's. */
  model?: string
  /** The effort its latest request asked for (`turn.step`); a level or a token budget. */
  effort?: string
  /** Input side of its latest response: uncached + cache-written + cache-read tokens. */
  contextTokens?: number
  /** Every token of every response seen (input + output + cache read + cache write), summed. */
  tokens?: number
  /** Those responses priced at API list prices: an estimate (no event carries dollars). */
  costUsd?: number
  /** From `agent.spawn`: the task's few words and the agent type. */
  description?: string
  type?: string
  /** From `agent.spawn`: the workflow run that started it (such agents are never in `$.agent.list()`). */
  workflowRunId?: string
  /** True once seen spawned or listed: a subagent, not an engine fork (compaction, memory). */
  isSubagent?: boolean
  /** The id of the loop that spawned it (`agent.spawn`'s `parentAgentId`); absent = the main loop. */
  parentId?: string
  /** What SendMessage addresses it by (`Agent({ name })`, or the list's `name`). */
  name?: string
  /** Last time the record changed (a request, a spawn, an end), for pruning and the quiet rule. */
  touchedAt: number
}

export type SubagentMonitorAgents = Record<string, SubagentMonitorAgent>

/** Token counts summed over every response the mod has seen this session (main loop and agents). */
export type SubagentMonitorTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Which screen the pane shows: the list (agentId null) or one agent's detail, and its open sections. */
export type SubagentMonitorView = {
  agentId: string | null
  isPromptOpen: boolean
  isResultOpen: boolean
}

/** Which list sections the person folded away: true hides that section's rows, never its head. */
export type SubagentMonitorCollapsed = {
  live: boolean
  finished: boolean
  map: boolean
}

/** Delivered messages from one loop to another; the main loop's id is the literal `'main'`. */
export type SubagentMonitorLink = {
  from: string
  to: string
  count: number
  /** When the latest of them was delivered, in `$.clock.now()` ms. */
  lastAt: number
}

/** Keyed `${from}>${to}`. Never holds a message's text. */
export type SubagentMonitorLinks = Record<string, SubagentMonitorLink>

/** One tool call of a subagent, for the feed under the map: a short label, never its input or output. */
export type SubagentMonitorActivity = {
  id: number
  agentId: string
  tool: string
  label: string
  startedAt: number
  endedAt?: number
  status: 'run' | 'ok' | 'err' | 'block'
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': {
      agents: SubagentMonitorAgents
      totals: SubagentMonitorTotals
      /** Whether the pane is open and drawn; null until the mod first decides (auto-open once). */
      isOpen: boolean | null
      /** True once a typed prompt opened the waiting (or closed) pane: later prompts never reopen it. */
      autoOpened: boolean
      /** True once the person closed the pane by hand this session: prompts then leave it closed. */
      closedByHand: boolean
      /** The model id the main loop's requests name, to give subagents on it the session's window. */
      mainModel: string | null
      view: SubagentMonitorView
      /** The list's folded sections; all open by default, mirrored to `$.store` under `collapsed`. */
      collapsed: SubagentMonitorCollapsed
      /** Who messaged whom (SendMessage, delivered), for the map. */
      links: SubagentMonitorLinks
      /** Subagents' recent tool calls, newest last, at most 40. */
      activity: SubagentMonitorActivity[]
    }
  }
}
