// An agent's detail, read from its conversation (`$.session.messages({ agentId })`).
// Pure, so it is tested directly. Nothing of it goes to `$.state`.

import type { SessionMessage } from 'claude-code'

export const TIMELINE_CAP = 30

export type TimelineItem =
  | { kind: 'tool'; id: string; tool: string; summary: string; status: 'running' | 'ok' | 'error' }
  | { kind: 'text'; id: string; text: string }

export type AgentDetail = {
  /** The task the agent was given: its conversation's first user message. */
  prompt: string
  /** Its latest tool calls and the words between them, oldest first. */
  timeline: TimelineItem[]
  /** How many earlier items the cap left out. */
  hidden: number
  /** Its last assistant text: the report, once the run ended. */
  result: string | undefined
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** What a call was about, in a few words: the path it read, the command it ran, the pattern it sought. */
export const toolSummary = (tool: string, input: Record<string, unknown>): string => {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }

    return undefined
  }
  const path = pick('file_path', 'notebook_path', 'path')
  const named: Record<string, string | undefined> = {
    Read: path,
    Edit: path,
    Write: path,
    NotebookEdit: path,
    Bash: pick('description', 'command'),
    PowerShell: pick('description', 'command'),
    Grep: pick('pattern'),
    Glob: pick('pattern'),
    WebFetch: pick('url'),
    WebSearch: pick('query'),
    Agent: pick('description'),
    Skill: pick('skill'),
  }
  const found = tool in named ? named[tool] : Object.values(input).find(v => typeof v === 'string')

  return oneLine(typeof found === 'string' ? found : '')
}

export const buildDetail = (messages: readonly SessionMessage[]): AgentDetail => {
  const prompt = messages.find(message => message.role === 'user' && message.text.trim() !== '')?.text ?? ''
  const items: TimelineItem[] = []
  let result: string | undefined

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    const text = message.text.trim()
    if (text !== '') {
      items.push({ kind: 'text', id: `t${index}`, text: oneLine(text) })
      result = message.text.trim()
    }
    for (const use of message.toolUses) {
      items.push({
        kind: 'tool',
        id: use.tool_use_id,
        tool: use.tool,
        summary: toolSummary(use.tool, use.input),
        status: use.isError ? 'error' : use.text === undefined ? 'running' : 'ok',
      })
    }
  })

  const hidden = Math.max(0, items.length - TIMELINE_CAP)

  return { prompt, timeline: items.slice(hidden), hidden, result }
}

/** The first `lines` lines of `text`, each at most `columns` wide, and whether anything was cut. */
export const clampLines = (text: string, lines: number, columns: number): { text: string; isCut: boolean } => {
  const width = Math.max(10, columns)
  const rows: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') rows.push('')
    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width))
    if (rows.length > lines) break
  }
  const isCut = rows.length > lines

  return { text: isCut ? `${rows.slice(0, lines).join('\n')}…` : text, isCut }
}
