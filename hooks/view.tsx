// The pane and the band, drawn from plain data. No `$` here: the hooks module
// reads the engine and hands this file data and press callbacks.
//
// Desktop measurements (from the live render): a spacing unit of 1 (gap,
// padding) is 8px, Box backgroundColor and flexGrow work, Svg draws at its
// given pixel size, and Text draws in a proportional face (so runs of line
// glyphs are not bars). An empty Box does not paint its background there, so
// bars and hairlines are filled Svgs clipped by flexGrow Boxes (see fillRow).
// The terminal keeps glyphs and theme colours.

import type { Elements, RenderElement } from 'claude-code'

import type { SubagentMonitorCollapsed, SubagentMonitorTotals } from '../types'
import type { AgentDetail, TimelineItem } from './detail'
import { clampLines } from './detail'
import { effortLevel, filledCells, formatElapsed, formatTokens, formatUsd, modelFamily, modelName } from './format'
import type { RowState } from './rows'
import { sections } from './rows'
import type { Palette, TypeLook } from './theme'
import {
  DESKTOP,
  TERMINAL,
  WARN_PCT,
  effortSvg,
  iconSvg,
  modelSwatch,
  monoTextSvg,
  pulseDotSvg,
  fillSvg,
  svgHeight,
  svgWidth,
  tileSvg,
  typeLook,
} from './theme'

type AnyElements = Elements[keyof Elements]

/** What a drawing needs from its surface: the elements, the palette, the width, the second. */
export type Kit = {
  Box: AnyElements['Box']
  Text: AnyElements['Text']
  Button: AnyElements['Button']
  /** The desktop's (and other remote surfaces') SVG; absent on the terminal. */
  Svg: Elements['desktop']['Svg'] | undefined
  p: Palette
  cols: number
  beat: number
}

const BORDER = '#2A2A31'

export const kitFor = (els: AnyElements, surface: string, cols: number, now: number): Kit => {
  // Every table is completed with every element name (one a surface lacks draws a
  // fragment), so the surface, not the table, says whether SVG is drawn.
  const Svg = surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

  return {
    Box: els.Box,
    Text: els.Text,
    Button: els.Button,
    Svg,
    p: Svg === undefined ? TERMINAL : DESKTOP,
    cols: Math.max(24, cols),
    beat: Math.floor(now / 1000),
  }
}

/** A spacing in the handoff's pixels on the desktop (8px a unit), in cells on the terminal. */
const space = (k: Kit, px: number, cells: number): number => (k.Svg ? px / 8 : cells)

export type AgentView = {
  id: string
  task: string
  type: string
  state: RowState
  isLive: boolean
  elapsedMs: number | undefined
  /** For the list's order: latest start first among the live. */
  startedAt: number | undefined
  /** For the list's order: latest end first among the finished. */
  endedAt: number | undefined
  isApproximate: boolean
  model: string | undefined
  effort: string | undefined
  tokens: number
  costUsd: number | undefined
  ctxUsed: number | undefined
  ctxMax: number | undefined
  ctxIsEstimate: boolean
}

export type SummaryView = {
  costUsd: number | undefined
  tokens: number
  mainCostUsd: number | undefined
  subCostUsd: number
  breakdown: SubagentMonitorTotals
  running: number
  done: number
}

export type DetailState =
  | { kind: 'ready'; detail: AgentDetail }
  | { kind: 'unavailable'; reason: string }

export type Actions = {
  close: () => unknown
  open: (id: string) => unknown
  back: () => unknown
  togglePrompt: () => unknown
  toggleResult: () => unknown
  toggleLive: () => unknown
  toggleFinished: () => unknown
}

// ---- Small pieces -------------------------------------------------------------

const ellipsis = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

const svg = (k: Kit, source: string, alt: string, isInteractive?: boolean) => {
  const { Svg } = k
  if (Svg === undefined) return null

  return (
    <Svg
      source={source}
      alt={alt}
      width={svgWidth(source)}
      height={svgHeight(source)}
      {...(isInteractive ? { isInteractive: true as const } : {})}
    />
  )
}

/**
 * Desktop: a row of parts `height` px tall, each as wide as its share.
 *
 * Each part paints itself: a Box of `width={0}` (so its flex basis is 0 and
 * `flexGrow` alone sets its share of the row), `minWidth={0}` and
 * `overflow="hidden"`, holding one filled Svg far wider than any pane. The Svg
 * draws at its given CSS pixels (SvgProps.width/height) and the Box clips it to
 * the share (BoxProps.overflow); its `preserveAspectRatio="none"` viewBox also
 * fills the part if a surface scales it to the slot instead. Nothing depends on
 * an empty Box painting its background, which the live desktop did not do.
 */
const fillRow = (
  k: Kit,
  key: string,
  height: number,
  parts: { grow: number; color: string; gapAfter?: number }[],
) => {
  const { Box } = k

  return (
    <Box key={key} flexDirection="row">
      {parts.flatMap((part, index) => {
        const cells = []
        if (part.grow > 0) {
          cells.push(
            <Box key={`${key}-${index}`} flexGrow={part.grow} flexShrink={1} width={0} minWidth={0} overflow="hidden">
              {svg(k, fillSvg(height, part.color), `${key} ${index}`)}
            </Box>,
          )
        }
        if (part.gapAfter) {
          cells.push(<Box key={`${key}-${index}-gap`} width={part.gapAfter / 8} flexShrink={0} />)
        }

        return cells
      })}
    </Box>
  )
}

/**
 * The handoff's 1px border line, full width; a line of `─` on the terminal.
 * Keyed on a Box on both surfaces: a Text's key does not reach the drawn tree.
 */
const hairline = (k: Kit, key: string) => {
  const { Box, Text } = k

  return k.Svg ? (
    fillRow(k, key, 1, [{ grow: 1, color: BORDER }])
  ) : (
    <Box key={key}>
      <Text color="inactive">{'─'.repeat(k.cols)}</Text>
    </Box>
  )
}

/** A bar `percent` full: the 4px context bar, rounded ends aside; glyphs on the terminal. */
const bar = (k: Kit, key: string, percent: number, color: string, height: number) => {
  const { Text } = k
  const pct = Math.min(100, Math.max(0, percent))
  if (k.Svg) return fillRow(k, key, height, [{ grow: pct, color }, { grow: 100 - pct, color: BORDER }])

  const cells = k.cols - 6
  const filled = filledCells(pct, cells)

  return (
    <Text key={key}>
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text color={k.p.off}>{'─'.repeat(cells - filled)}</Text>
    </Text>
  )
}

/** The handoff's labels: uppercase, muted. */
const label = (k: Kit, text: string) => {
  const { Text } = k

  return <Text color={k.p.muted}>{text.toUpperCase()}</Text>
}

const tile = (k: Kit, look: TypeLook) => {
  const { Text } = k

  return k.Svg ? svg(k, tileSvg(look), look.short) : <Text color={look.term}>{look.glyph}</Text>
}

/** Running: the pulsing dot. Done: a tick. Failed or stopped: a cross. */
const statusMark = (k: Kit, state: RowState) => {
  const { Text } = k
  if (state === 'running' || state === 'waiting') {
    const color = state === 'running' ? k.p.running : k.p.warn
    if (k.Svg) return svg(k, pulseDotSvg(color), state, true)

    return <Text color={color}>{k.beat % 2 === 0 ? '●' : '◉'}</Text>
  }
  if (state === 'failed' || state === 'stopped') return <Text color={k.p.warn}>✕</Text>
  if (k.Svg) return svg(k, iconSvg('check', 11, DESKTOP.muted, 2.6), 'done')

  return <Text color={k.p.muted}>✓</Text>
}

/** A chip: a filled Box with the handoff's 3px 8px padding on the desktop; plain on the terminal. */
const chip = (k: Kit, key: string, bg: string | undefined, children: unknown[]) => {
  const { Box } = k

  return (
    <Box
      key={key}
      flexDirection="row"
      alignItems="center"
      gap={space(k, 6, 1)}
      paddingX={space(k, 8, 0)}
      paddingY={space(k, 3, 0)}
      {...(k.Svg && bg ? { backgroundColor: bg } : {})}
    >
      {children as never}
    </Box>
  )
}

const modelBadge = (k: Kit, model: string | undefined) => {
  const { Text } = k
  const swatch = modelSwatch(modelFamily(model))

  return chip(k, 'model', swatch.bg, [
    <Text key="name" bold color={k.Svg ? swatch.fg : swatch.term}>
      {modelName(model)}
    </Text>,
  ])
}

/** Five rising segments, the active ones in the accent, then the level's name. */
const effortChip = (k: Kit, effort: string | undefined) => {
  const { Text } = k
  const level = effortLevel(effort)
  const segs = '▂▃▄▅▆'
  const meter = k.Svg ? (
    svg(k, effortSvg(level, DESKTOP.accent, DESKTOP.off), `effort ${level} of 5`)
  ) : (
    <Text key="segs">
      <Text color={k.p.accent}>{segs.slice(0, level)}</Text>
      <Text color={k.p.off}>{segs.slice(level)}</Text>
    </Text>
  )

  return chip(k, 'effort', k.p.chip, [
    meter,
    <Text key="level" color={k.p.text2}>
      {effort ?? '—'}
    </Text>,
  ])
}

const contextBlock = (k: Kit, agent: AgentView) => {
  const { Box, Text } = k
  const known = agent.ctxUsed !== undefined && agent.ctxMax !== undefined
  const percent = known ? Math.min(100, Math.round((agent.ctxUsed! / agent.ctxMax!) * 100)) : 0
  const isWarn = percent >= WARN_PCT
  const approx = agent.ctxIsEstimate ? '~' : ''

  return (
    <Box key="context" flexDirection="column" gap={space(k, 4, 0)}>
      {bar(k, 'ctx-bar', percent, isWarn ? k.p.warn : k.p.ctx, 4)}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={k.p.muted}>Context</Text>
        <Text color={isWarn ? k.p.warn : k.p.muted}>
          {known
            ? `${formatTokens(agent.ctxUsed)} / ${approx}${formatTokens(agent.ctxMax)} · ${approx}${percent}%`
            : 'no request yet'}
        </Text>
      </Box>
    </Box>
  )
}

const elapsedText = (agent: AgentView): string =>
  agent.elapsedMs === undefined ? '—' : `${agent.isApproximate ? '≥' : ''}${formatElapsed(agent.elapsedMs)}`

/** The tile, then the title block: shared by a list row and the detail's head. */
const agentHead = (k: Kit, agent: AgentView, title: unknown, children: unknown[]) => {
  const { Box, Text } = k

  return (
    <Box flexDirection="row" alignItems="flex-start" gap={space(k, 12, 1)}>
      {tile(k, typeLook(agent.type))}
      <Box flexDirection="column" flexGrow={1} gap={space(k, 8, 0)}>
        <Box flexDirection="column" gap={space(k, 2, 0)}>
          {title as never}
          <Box flexDirection="row" alignItems="center" gap={space(k, 6, 1)}>
            {statusMark(k, agent.state)}
            <Text color={k.p.muted} wrap="truncate-end">
              {agent.type} · {elapsedText(agent)}
              {agent.state === 'failed' || agent.state === 'stopped' ? ` · ${agent.state}` : ''}
            </Text>
          </Box>
        </Box>
        {children as never}
      </Box>
    </Box>
  )
}

const chipsRow = (k: Kit, agent: AgentView) => {
  const { Box, Text } = k

  return (
    <Box key="chips" flexDirection="row" alignItems="center" gap={space(k, 6, 1)}>
      {modelBadge(k, agent.model)}
      {effortChip(k, agent.effort)}
      <Box flexGrow={1} />
      <Text color={k.p.muted}>{formatTokens(agent.tokens)} tok</Text>
    </Box>
  )
}

// ---- The pane: list -------------------------------------------------------------

const header = (k: Kit, actions: Actions, count: number | undefined, back: boolean) => {
  const { Box, Text, Button } = k

  return (
    <Box
      key="header"
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={space(k, 20, 0)}
      paddingY={space(k, 16, 0)}
    >
      {back ? (
        <Button key="back" plain hotkey="b" onPress={actions.back}>
          <Text color={k.p.text}>← Back</Text>
        </Button>
      ) : (
        <Box flexDirection="row" alignItems="center" gap={space(k, 10, 1)}>
          {k.Svg ? svg(k, iconSvg('list', 18, DESKTOP.text, 1.8), 'Subagents') : null}
          <Text bold color={k.p.text}>
            Subagents
          </Text>
          {count === undefined ? null : chip(k, 'count', k.p.chip, [<Text key="n" color={k.p.muted}>{count}</Text>])}
        </Box>
      )}
      {k.Svg ? null : (
        // The desktop's pane chrome has its own ×; the terminal gets ours.
        <Button key="close" role="dismiss" plain label="Close panel" onPress={actions.close}>
          <Text color={k.p.muted}>×</Text>
        </Button>
      )}
    </Box>
  )
}

const summary = (k: Kit, s: SummaryView) => {
  const { Box, Text } = k
  const cost = formatUsd(s.costUsd)
  const tokens = formatTokens(s.tokens)
  const main = s.mainCostUsd ?? 0
  const total = main + s.subCostUsd
  const mainShare = total > 0 ? main / total : 1
  const tiles: [string, number][] = [
    ['Input', s.breakdown.input],
    ['Output', s.breakdown.output],
    ['Cache read', s.breakdown.cacheRead],
    ['Cache write', s.breakdown.cacheWrite],
  ]
  const split = k.Svg ? (
    fillRow(k, 'split', 6, [
      { grow: Math.round(mainShare * 1000), color: DESKTOP.text, ...(mainShare > 0 && mainShare < 1 ? { gapAfter: 2 } : {}) },
      { grow: Math.round((1 - mainShare) * 1000), color: DESKTOP.accent },
    ])
  ) : (
    <Text key="split">
      <Text color={k.p.text}>{'━'.repeat(filledCells(mainShare * 100, k.cols - 1))}</Text>
      <Text color={k.p.accent}>{'━'.repeat(k.cols - 1 - filledCells(mainShare * 100, k.cols - 1))}</Text>
    </Text>
  )

  return (
    <Box key="summary" flexDirection="column" gap={space(k, 16, 1)} padding={space(k, 20, 0)}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
        <Box flexDirection="column" gap={space(k, 4, 0)}>
          {label(k, 'Session total · API')}
          {k.Svg ? (
            svg(k, monoTextSvg(cost, 36, DESKTOP.accent, 'start'), cost)
          ) : (
            <Text bold color={k.p.accent}>
              {cost}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" alignItems="flex-end" gap={space(k, 4, 0)}>
          {k.Svg ? (
            svg(k, monoTextSvg(tokens, 18, DESKTOP.text, 'end'), `${tokens} tokens`)
          ) : (
            <Text bold color={k.p.text}>
              {tokens}
            </Text>
          )}
          <Text color={k.p.muted}>tokens</Text>
        </Box>
      </Box>
      {split}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={k.p.muted}>
          <Text color={k.p.text}>■</Text> Main thread <Text color={k.p.text}>{formatUsd(s.mainCostUsd)}</Text>
        </Text>
        <Text color={k.p.muted}>
          <Text color={k.p.accent}>■</Text> Subagents <Text color={k.p.text}>{formatUsd(s.subCostUsd)}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {tiles.map(([name, value]) => (
          <Box
            key={`tile-${name}`}
            flexDirection="column"
            flexGrow={1}
            gap={space(k, 2, 0)}
            paddingX={space(k, 10, 1)}
            paddingY={space(k, 8, 0)}
            {...(k.p.tile ? { backgroundColor: k.p.tile } : {})}
          >
            <Text color={k.p.muted} wrap="truncate-end">
              {name}
            </Text>
            <Text color={k.p.text}>{formatTokens(value)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

const row = (k: Kit, agent: AgentView, actions: Actions) => {
  const { Box, Text, Button } = k
  const cost = formatUsd(agent.costUsd)
  const room = k.cols - (k.Svg ? 12 : 6) - cost.length

  const title = (
    <Box key="title" flexDirection="row" justifyContent="space-between" gap={space(k, 8, 1)}>
      <Button key={`open-${agent.id}`} plain onPress={() => actions.open(agent.id)}>
        <Text bold color={k.p.text}>
          {ellipsis(agent.task, room)}
        </Text>
        <Text color={k.p.muted}> ›</Text>
      </Button>
      <Text color={k.p.text}>{cost}</Text>
    </Box>
  )

  return (
    <Box
      key={`agent-${agent.id}`}
      flexDirection="column"
      paddingX={space(k, 8, 0)}
      paddingY={space(k, 12, 0)}
      {...(agent.isLive && k.p.surface2 ? { backgroundColor: k.p.surface2 } : {})}
    >
      {agentHead(k, agent, title, [chipsRow(k, agent), contextBlock(k, agent)])}
    </Box>
  )
}

/** What a section's head toggles: its Button's key, whether it is folded, the press. */
type Fold = { key: string; isCollapsed: boolean; toggle: () => unknown }

/**
 * A section's head row: the uppercase label behind its chevron (▾ open, ▸
 * folded) as one plain Button, so a click on it folds the section; and what
 * sits at its right, outside the Button (a Button holds Text alone). A folded
 * section with another below keeps the gap its rows would have left.
 */
const listHead = (k: Kit, key: string, name: string, fold: Fold, gapAfter: boolean, right: unknown) => {
  const { Box, Button } = k

  return (
    <Box
      key={key}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={space(k, 20, 0)}
      paddingTop={space(k, 12, 1)}
      paddingBottom={fold.isCollapsed ? space(k, 16, gapAfter ? 1 : 0) : space(k, 4, 0)}
    >
      <Button key={fold.key} plain onPress={fold.toggle}>
        {label(k, `${fold.isCollapsed ? '▸' : '▾'} ${name}`)}
      </Button>
      {right as never}
    </Box>
  )
}

/** A section's rows; `gapAfter` leaves the 16px (a line on the terminal) above the next section's rule. */
const listBody = (k: Kit, key: string, gapAfter: boolean, children: unknown) => {
  const { Box } = k

  return (
    <Box
      key={key}
      flexDirection="column"
      gap={space(k, 4, 1)}
      paddingX={space(k, 12, 0)}
      paddingTop={space(k, 4, 0)}
      paddingBottom={space(k, 16, gapAfter ? 1 : 0)}
    >
      {children as never}
    </Box>
  )
}

/** A muted note in place of a section's rows. */
const listNote = (k: Kit, key: string, lines: string[]) => {
  const { Box, Text } = k

  return (
    <Box key={key} flexDirection="column" paddingX={space(k, 8, 0)} paddingY={space(k, 12, 0)}>
      {lines.map(line => (
        <Text key={line} color={k.p.muted}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The list: the live agents under AGENTS, then, past a rule, the finished ones
 * under FINISHED (left out when none has finished). Either section folds by a
 * click on its head: its rows and notes go, its head (and FINISHED's rule) stay.
 */
export const listPane = (
  k: Kit,
  s: SummaryView,
  agents: AgentView[],
  collapsed: SubagentMonitorCollapsed,
  actions: Actions,
): RenderElement => {
  const { Box, Text } = k
  const { live, finished } = sections(agents)
  const hasFinished = finished.length > 0

  return (
    <Box flexDirection="column">
      {header(k, actions, agents.length, false)}
      {hairline(k, 'rule-header')}
      {summary(k, s)}
      {hairline(k, 'rule-summary')}
      {listHead(
        k,
        'list-head',
        'Agents',
        { key: 'toggle-live', isCollapsed: collapsed.live, toggle: actions.toggleLive },
        hasFinished,
        <Text color={k.p.muted}>
          <Text color={k.p.running}>{s.running} running</Text> · {s.done} done
        </Text>,
      )}
      {collapsed.live
        ? null
        : listBody(
            k,
            'list',
            hasFinished,
            agents.length === 0
              ? listNote(k, 'empty', ['No subagents running', 'Each one shows up here as it starts.'])
              : live.length === 0
                ? listNote(k, 'no-running', ['No agents running'])
                : live.map(agent => row(k, agent, actions)),
          )}
      {hasFinished ? hairline(k, 'finished-rule') : null}
      {hasFinished
        ? listHead(
            k,
            'finished-label',
            `Finished · ${finished.length}`,
            { key: 'toggle-finished', isCollapsed: collapsed.finished, toggle: actions.toggleFinished },
            false,
            null,
          )
        : null}
      {hasFinished && !collapsed.finished
        ? listBody(k, 'finished-list', false, finished.map(agent => row(k, agent, actions)))
        : null}
    </Box>
  )
}

// ---- The pane: one agent's detail -------------------------------------------------

const timelineItem = (k: Kit, item: TimelineItem) => {
  const { Text } = k
  if (item.kind === 'text') {
    return (
      <Text key={`item-${item.id}`} color={k.p.muted} italic wrap="truncate-end">
        “{item.text}”
      </Text>
    )
  }
  const mark = item.status === 'running' ? '●' : item.status === 'error' ? '✕' : '✓'
  const color = item.status === 'running' ? k.p.running : item.status === 'error' ? k.p.warn : k.p.muted

  return (
    <Text key={`item-${item.id}`} wrap="truncate-end">
      <Text color={color}>{mark}</Text> <Text bold color={k.p.text}>{item.tool}</Text>{' '}
      <Text color={k.p.muted}>{item.summary}</Text>
    </Text>
  )
}

/** A long text shown `lines` lines tall, with its Show more / Show less control. */
const clamped = (k: Kit, key: string, text: string, lines: number, isOpen: boolean, toggle: () => unknown) => {
  const { Box, Text, Button } = k
  const cut = clampLines(text, lines, k.cols)

  return (
    <Box key={key} flexDirection="column" gap={space(k, 4, 0)}>
      <Text color={k.p.text2} wrap="wrap">
        {isOpen ? text : cut.text}
      </Text>
      {cut.isCut ? (
        <Button key={`${key}-more`} plain onPress={toggle}>
          <Text color={k.p.ctx}>{isOpen ? 'Show less' : 'Show more'}</Text>
        </Button>
      ) : null}
    </Box>
  )
}

const section = (k: Kit, key: string, name: string, children: unknown[]) => {
  const { Box } = k

  return (
    <Box key={key} flexDirection="column" gap={space(k, 6, 0)}>
      {label(k, name)}
      {children as never}
    </Box>
  )
}

export const detailPane = (
  k: Kit,
  agent: AgentView,
  detail: DetailState,
  open: { prompt: boolean; result: boolean },
  actions: Actions,
): RenderElement => {
  const { Box, Text } = k
  const title = (
    <Text key="title" bold color={k.p.text} wrap="wrap">
      {agent.task}
    </Text>
  )
  const totals = (
    <Text key="totals">
      <Text color={k.p.text}>{formatUsd(agent.costUsd)}</Text>
      <Text color={k.p.muted}> · {formatTokens(agent.tokens)} tok</Text>
    </Text>
  )

  return (
    <Box flexDirection="column">
      {header(k, actions, undefined, true)}
      {hairline(k, 'rule-header')}
      <Box key="detail-head" flexDirection="column" padding={space(k, 20, 0)}>
        {agentHead(k, agent, title, [totals, chipsRow(k, agent), contextBlock(k, agent)])}
      </Box>
      {hairline(k, 'rule-head')}
      {detail.kind === 'unavailable' ? (
        <Box key="unavailable" flexDirection="column" padding={space(k, 20, 0)} gap={space(k, 4, 0)}>
          <Text color={k.p.muted}>Details unavailable for this agent.</Text>
          <Text color={k.p.muted} wrap="wrap">
            {detail.reason}
          </Text>
        </Box>
      ) : (
        <Box key="detail-body" flexDirection="column" gap={space(k, 16, 1)} padding={space(k, 20, 0)}>
          {section(k, 'prompt-section', 'Prompt', [
            clamped(k, 'prompt', detail.detail.prompt || '—', 6, open.prompt, actions.togglePrompt),
          ])}
          {section(k, 'activity', 'Activity', [
            detail.detail.hidden > 0 ? (
              <Text key="hidden" color={k.p.muted}>
                {detail.detail.hidden} earlier steps not shown
              </Text>
            ) : null,
            ...(detail.detail.timeline.length === 0
              ? [
                  <Text key="none" color={k.p.muted}>
                    No tool calls yet.
                  </Text>,
                ]
              : detail.detail.timeline.map(item => timelineItem(k, item))),
          ])}
          {!agent.isLive && detail.detail.result !== undefined
            ? section(k, 'result-section', 'Result', [
                clamped(k, 'result', detail.detail.result, 12, open.result, actions.toggleResult),
              ])
            : null}
        </Box>
      )}
    </Box>
  )
}

// ---- The band -------------------------------------------------------------------

/** One Button over the whole band, so a click anywhere on it opens or closes the pane. */
export const band = (k: Kit, s: SummaryView, agents: AgentView[], toggle: () => unknown): RenderElement => {
  const { Box, Text, Button } = k
  const tokens = `${formatTokens(s.tokens)} tok`
  const cost = formatUsd(s.costUsd)
  const fixed = 'AGENTS  '.length + 3 + tokens.length + 1 + cost.length + 5
  let room = k.cols - fixed
  const shown: { agent: AgentView; text: string; pct: string }[] = []
  for (const [index, agent] of agents.entries()) {
    const look = typeLook(agent.type)
    const pct =
      agent.ctxUsed === undefined || agent.ctxMax === undefined
        ? '—'
        : `${Math.min(100, Math.round((agent.ctxUsed / agent.ctxMax) * 100))}%`
    const text = `${look.short} · ${modelName(agent.model).split(' ')[0]}`
    const width = text.length + pct.length + 6
    const left = agents.length - index - 1
    if (width > room - (left > 0 ? 4 : 0)) break
    room -= width
    shown.push({ agent, text, pct })
  }
  const more = agents.length - shown.length
  const chipBg = k.p.tile ? { backgroundColor: k.p.tile } : {}

  return (
    <Box flexDirection="row">
      <Button key="subagents-band" plain onPress={toggle}>
        <Text color={k.p.muted}>AGENTS </Text>
        {agents.length === 0 ? <Text color={k.p.muted}> none yet </Text> : null}
        {shown.map(({ agent, text, pct }) => {
          const isWarn = pct !== '—' && Number.parseInt(pct, 10) >= WARN_PCT
          const dot = agent.isLive
            ? k.Svg
              ? k.beat % 2 === 0
                ? DESKTOP.running
                : '#4B7D5F'
              : k.p.running
            : k.Svg
              ? DESKTOP.done
              : k.p.done

          return (
            <Text key={`chip-${agent.id}`}>
              {' '}
              <Text {...chipBg}>
                {' '}
                <Text color={dot}>{agent.isLive && !k.Svg && k.beat % 2 === 1 ? '◉' : '●'}</Text>{' '}
                <Text color={k.p.text2}>{text}</Text> <Text color={isWarn ? k.p.warn : k.p.muted}>{pct}</Text>{' '}
              </Text>
            </Text>
          )
        })}
        {more > 0 ? <Text color={k.p.muted}> +{more}</Text> : null}
        <Text color={k.Svg ? BORDER : k.p.off}> │ </Text>
        <Text color={k.p.muted}>{tokens} </Text>
        <Text bold color={k.p.accent}>
          {cost}
        </Text>
      </Button>
    </Box>
  )
}
