// Pure helpers: no `$`, so they are tested directly.

import type { AgentInfo, AgentStatus, ModelUsage } from 'claude-code'

const ACTIVE: readonly AgentStatus[] = ['pending', 'running', 'waiting']

export const isActive = (status: AgentStatus): boolean => ACTIVE.includes(status)

/** `$0.71`; `—` when unknown. */
export const formatUsd = (usd: number | undefined): string =>
  usd === undefined ? '—' : `$${usd.toFixed(2)}`

/** The handoff's numbers: `1.24M`, `2M`, `86.4k`, `121k`, `850`; `—` when unknown. */
export const formatTokens = (tokens: number | undefined): string => {
  if (tokens === undefined) return '—'
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
  if (tokens >= 1e3) return `${String(Math.round(tokens / 100) / 10).replace(/\.0$/, '')}k`

  return String(Math.round(tokens))
}

/** `58s`, `4m 12s`, `3m 05s`, `1h 07m`. */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`

  return `${s}s`
}

/** The input side of one response: what its context held. */
export const contextTokensOf = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

/** Every token one response was billed for. */
export const allTokensOf = (usage: ModelUsage): number => contextTokensOf(usage) + usage.output_tokens

/** `opus`, `sonnet`, `haiku`, `fable`, ... from an id or alias. */
export const modelFamily = (model: string | undefined): string | undefined =>
  model === undefined ? undefined : /(opus|sonnet|haiku|fable|mythos)/i.exec(model)?.[1]?.toLowerCase()

/** `claude-haiku-4-5-20251001` -> `Haiku 4.5`; `claude-opus-5-5[1m]` -> `Opus 5.5`; `haiku` -> `Haiku`. */
export const modelName = (model: string | undefined): string => {
  if (model === undefined) return '—'
  const family = modelFamily(model)
  if (family === undefined) return model.replace(/^claude-/, '')
  const version = new RegExp(`${family}[-_ ]?(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?`, 'i').exec(model)
  const name = family[0]!.toUpperCase() + family.slice(1)
  if (version?.[1] === undefined) return name

  return `${name} ${version[1]}${version[2] === undefined ? '' : `.${version[2]}`}`
}

/** The family name alone, for the band's chips: `Opus`. */
export const modelShort = (model: string | undefined): string => modelName(model).split(' ')[0] ?? '—'

/** A numeric thinking budget as `4096 tok`; a level as is. */
export const formatEffort = (effort: string | number | undefined): string | undefined =>
  effort === undefined ? undefined : typeof effort === 'number' ? `${effort} tok` : effort

/** The handoff's 5-step effort meter: low=1 ... max=5; 0 when unknown. */
export const effortLevel = (effort: string | undefined): number =>
  ({ low: 1, medium: 2, high: 3, xhigh: 4, max: 5 })[effort ?? ''] ?? 0

/** What a row is called: its task, else its SendMessage name, else its type. */
export const agentLabel = (agent: Pick<AgentInfo, 'name' | 'description' | 'type'>): string =>
  agent.description || agent.name || agent.type

/** A context window and whether it is the engine's own figure or this mod's estimate. */
export type ContextWindow = { tokens: number; isEstimate: boolean }

/**
 * No API names a model's window (only the main session's `context.window`), so:
 * the main model's own window when the agent runs on it, else a `[1m]` id's
 * million, else the standard 200k, marked as an estimate.
 */
export const windowFor = (
  model: string | undefined,
  mainModel: string | null,
  sessionWindow: number | undefined,
): ContextWindow | undefined => {
  if (model === undefined) return undefined
  if (model === mainModel && sessionWindow !== undefined) return { tokens: sessionWindow, isEstimate: false }

  return { tokens: /\[1m\]/i.test(model) ? 1_000_000 : 200_000, isEstimate: true }
}

/** Whole percent of the window used, clamped to 0..100. */
export const percentOf = (tokens: number, window: number): number =>
  Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))

/** A thin bar of `cells` heavy-line glyphs: how many are filled. */
export const filledCells = (percent: number, cells: number): number =>
  Math.round((Math.min(100, Math.max(0, percent)) / 100) * Math.max(1, cells))

// ---- Prices -----------------------------------------------------------------
// No event or `$` call reports a subagent's dollars (ModelUsage and TurnUsage
// carry token counts only; `$.session.usage().cost` is the whole session), so a
// subagent's cost is estimated from its token counts at first-party API list
// prices (USD per million tokens, cached 2026-10-06 in the claude-api skill):
// cache writes at 1.25x input (5-minute TTL), cache reads at each model's rate.

type Price = { input: number; output: number; read: number; write: number }

const price = (input: number, output: number, read: number): Price => ({ input, output, read, write: input * 1.25 })

const PRICES: readonly [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, price(10, 50, 0.25)],
  [/fable|mythos/, price(10, 50, 1)],
  [/opus-5-5/, price(4, 20, 0.2)],
  [/opus-(5|4-[678])/, price(5, 25, 0.5)],
  [/opus/, price(4, 20, 0.2)],
  [/sonnet-5/, price(2, 10, 0.2)],
  [/sonnet-4-6/, price(3, 15, 0.3)],
  [/sonnet/, price(2, 10, 0.2)],
  [/haiku-5-5/, price(0.1, 0.5, 0.01)],
  [/haiku/, price(1, 5, 0.1)],
]

/** Estimated USD for one response's tokens; undefined for a model the table does not know. */
export const estimateUsd = (model: string | undefined, usage: ModelUsage): number | undefined => {
  if (model === undefined) return undefined
  const rate = PRICES.find(([pattern]) => pattern.test(model.toLowerCase()))?.[1]
  if (rate === undefined) return undefined

  return (
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      usage.cache_read_input_tokens * rate.read +
      usage.cache_creation_input_tokens * rate.write) /
    1e6
  )
}

// ---- Transcripts ------------------------------------------------------------

/** The first `"timestamp"` of a transcript's opening line, in epoch ms. */
export const firstTimestamp = (jsonl: string): number | undefined => {
  const end = jsonl.indexOf('\n')
  const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(end === -1 ? jsonl : jsonl.slice(0, end))
  const ms = match?.[1] === undefined ? Number.NaN : Date.parse(match[1])

  return Number.isNaN(ms) ? undefined : ms
}

/** How Claude Code names a project's transcript folder: every non-alphanumeric is `-`. */
export const projectKey = (root: string): string => root.replace(/[^a-zA-Z0-9]/g, '-')
