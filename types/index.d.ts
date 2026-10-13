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

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': {
      agents: SubagentMonitorAgents
      totals: SubagentMonitorTotals
      /** Whether the pane is open and drawn; null until the mod first decides (auto-open once). */
      isOpen: boolean | null
      /** The model id the main loop's requests name, to give subagents on it the session's window. */
      mainModel: string | null
      view: SubagentMonitorView
    }
  }
}
