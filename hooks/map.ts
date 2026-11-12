// The map, drawn: an SVG of the graph for the desktop, an indented tree for
// the terminal. Pure, so it is tested directly. The drawing style (edges cut
// at the node rims, pulses along the edges) follows lot-map's agents map
// (MIT), rewritten.
//
// The desktop redraws the image whenever its source changes, and the pane
// re-renders every second: so the source holds no clock at all. Every loop
// starts at 0s and repeats forever, and the one time-derived fact is a message
// edge's `isFresh`, which the graph sets; the same graph gives the same bytes.

import { modelFamily, modelName } from './format'
import type { Graph, GraphNode, Placed } from './graph'
import { layout, ringStepFor } from './graph'
import type { Palette } from './theme'
import { modelSwatch } from './theme'

/** The drawing's own box; the SVG is scaled to the pane's width. */
const W = 360
const H = 300
const NODE_R = 13
const ROOT_R = 22
const BEAT_MS = 1400
const FLIGHT_MS = 1500
const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif"

type Point = { x: number; y: number }

const n1 = (v: number): string => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '0')
/** A duration in SVG's seconds. */
const clock = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

const esc = (text: string): string =>
  text.replace(/[<>&"]/g, ch => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : '&quot;'))

/** Where a straight line from `from` towards `to` leaves the circle of radius `r` around `from`. */
const rim = (from: Point, to: Point, r: number): Point => {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1

  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

const radiusOf = (node: GraphNode | undefined): number => (node?.state === 'root' ? ROOT_R : NODE_R)

/** A message's curve: bowed to the sender's right, so A->B and B->A part and neither lies on the spawn line. */
const curve = (a: Point, b: Point, ra: number, rb: number): { d: string; end: Point } => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const bow = len * 0.22 + 10
  const control = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow }
  const start = rim(a, control, ra)
  const end = rim(b, control, rb + 2)

  return {
    d: `M${n1(start.x)} ${n1(start.y)}Q${n1(control.x)} ${n1(control.y)} ${n1(end.x)} ${n1(end.y)}`,
    end,
  }
}

/** One node: its circle (stroked in its model's colour), its state's mark, and its label under it. */
const nodeSvg = (node: GraphNode, at: Point, p: Palette): string => {
  const x = n1(at.x)
  const y = n1(at.y)
  const fill = p.tile ?? 'none'
  const ground = p.surface2 ?? 'none'
  const model = modelSwatch(modelFamily(node.model)).fg
  const labelText = (text: string, dy: number, size: number, color: string, weight = 400) =>
    `<text x="${x}" y="${n1(at.y + dy)}" text-anchor="middle" font-family="${FONT}" font-size="${size}" ` +
    `font-weight="${weight}" fill="${color}" stroke="${ground}" stroke-width="3" paint-order="stroke">${esc(text)}</text>`

  if (node.state === 'root') {
    const name = node.model === undefined ? '' : labelText(modelName(node.model), 10, 7.5, model)

    return (
      `<g data-node="${esc(node.id)}">` +
      `<circle cx="${x}" cy="${y}" r="${ROOT_R}" fill="${fill}" stroke="${model}" stroke-width="2"/>` +
      labelText(node.label, name === '' ? 3 : -1, 9, p.text, 600) +
      name +
      `</g>`
    )
  }

  const isDim = node.state === 'done' || node.state === 'idle' || node.state === 'stopped'
  const stroke = node.state === 'failed' ? p.warn : model
  let marks = ''
  if (node.state === 'running') {
    const beat = `dur="${clock(BEAT_MS)}" begin="0s" repeatCount="indefinite"`
    marks +=
      `<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="none" stroke="${p.running}" stroke-width="1.4" opacity="0">` +
      `<animate attributeName="r" values="${NODE_R};${NODE_R + 7}" ${beat}/>` +
      `<animate attributeName="opacity" values=".7;0" ${beat}/>` +
      `</circle>`
  } else if (node.state === 'waiting') {
    marks += `<circle cx="${x}" cy="${y}" r="${NODE_R + 4}" fill="none" stroke="${p.warn}" stroke-width="1.2" stroke-dasharray="2 3"/>`
  }

  return (
    `<g data-node="${esc(node.id)}"${isDim ? ' opacity=".45"' : ''}>` +
    marks +
    `<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>` +
    labelText(node.label, NODE_R + 10, 9, p.text2) +
    `</g>`
  )
}

/**
 * The map: faint ring guides, then spawn lines, then message curves (thicker
 * the more often used, one pulse along a fresh one), then the nodes on top.
 * `width` is the pixel width it is drawn at; the height keeps the aspect.
 */
export const drawGraph = (g: Graph, p: Palette, width: number): string => {
  const px = Math.max(1, Math.round(Number.isFinite(width) ? width : W))
  const py = Math.max(1, Math.round((px * H) / W))
  const ground = p.surface2 ?? 'none'
  const spots = layout(g, W, H)
  const at = new Map<string, Placed>(spots.map(spot => [spot.id, spot]))
  const byId = new Map(g.nodes.map(node => [node.id, node]))
  const step = ringStepFor(g, W, H)
  const deepest = Math.min(3, Math.max(0, ...g.nodes.map(node => node.depth)))

  let body = `<rect width="${W}" height="${H}" rx="10" fill="${ground}"/>`

  for (let ring = 1; ring <= deepest; ring++) {
    body +=
      `<circle cx="${n1(W / 2)}" cy="${n1(H / 2)}" r="${n1(ring * step)}" fill="none" stroke="${p.off}" ` +
      `stroke-width=".7" stroke-dasharray="2 5" opacity=".5"/>`
  }

  for (const edge of g.edges.filter(one => one.kind === 'spawn')) {
    const a = at.get(edge.from)
    const b = at.get(edge.to)
    if (a === undefined || b === undefined) continue
    const s = rim(a, b, radiusOf(byId.get(edge.from)))
    const e = rim(b, a, radiusOf(byId.get(edge.to)))
    const color = byId.get(edge.to)?.isLive ? p.muted : p.off
    body +=
      `<line data-edge="spawn" x1="${n1(s.x)}" y1="${n1(s.y)}" x2="${n1(e.x)}" y2="${n1(e.y)}" ` +
      `stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>`
  }

  for (const edge of g.edges.filter(one => one.kind === 'message')) {
    const a = at.get(edge.from)
    const b = at.get(edge.to)
    if (a === undefined || b === undefined) continue
    const { d, end } = curve(a, b, radiusOf(byId.get(edge.from)), radiusOf(byId.get(edge.to)))
    const weight = 1 + Math.min(2, Math.log2(1 + Math.max(0, edge.count)))
    body +=
      `<path data-edge="message" d="${d}" fill="none" stroke="${p.ctx}" stroke-width="${n1(weight)}" ` +
      `stroke-dasharray="3 4" stroke-linecap="round" opacity=".85"/>` +
      `<circle cx="${n1(end.x)}" cy="${n1(end.y)}" r="${n1(1.5 + weight / 2)}" fill="${p.ctx}"/>`

    // One flight when the edge turns fresh; the source changes again only when it goes stale.
    if (edge.isFresh === true) {
      const timing = `begin="0s" dur="${clock(FLIGHT_MS)}" fill="freeze"`
      body +=
        `<circle r="3" fill="${p.accent}" opacity="0">` +
        `<animateMotion path="${d}" ${timing}/>` +
        `<animate attributeName="opacity" values="1;1;0" keyTimes="0;.8;1" ${timing}/>` +
        `</circle>`
    }
  }

  for (const node of g.nodes) {
    const spot = at.get(node.id)
    if (spot !== undefined) body += nodeSvg(node, spot, p)
  }

  if (g.hidden > 0) {
    body +=
      `<text x="${W - 10}" y="${H - 10}" text-anchor="end" font-family="${FONT}" font-size="9" ` +
      `fill="${p.muted}">+${g.hidden} more</text>`
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${py}" viewBox="0 0 ${W} ${H}">` +
    `${body}</svg>`
  )
}

/** The terminal's map: the spawn tree, indented, then one line per message pair. */
export const treeLines = (g: Graph): string[] => {
  const root = g.nodes[0]
  if (root === undefined) return []
  const byId = new Map(g.nodes.map(node => [node.id, node]))
  const children = new Map<string, GraphNode[]>()
  for (const node of g.nodes.slice(1)) {
    if (node.parent === null) continue
    const kids = children.get(node.parent) ?? []
    kids.push(node)
    children.set(node.parent, kids)
  }

  const lines = [root.model === undefined ? root.label : `${root.label} · ${modelName(root.model)}`]
  const seen = new Set([root.id])
  const walk = (id: string, indent: string): void => {
    const kids = (children.get(id) ?? []).filter(kid => !seen.has(kid.id))
    kids.forEach((kid, index) => {
      seen.add(kid.id)
      const isLast = index === kids.length - 1
      lines.push(`${indent}${isLast ? '└─' : '├─'} ${kid.label} · ${kid.state}`)
      walk(kid.id, `${indent}${isLast ? '   ' : '│  '}`)
    })
  }
  walk(root.id, '')

  for (const edge of g.edges.filter(one => one.kind === 'message')) {
    const from = byId.get(edge.from)?.label ?? edge.from
    const to = byId.get(edge.to)?.label ?? edge.to
    lines.push(`${from} → ${to} ×${edge.count}`)
  }
  if (g.hidden > 0) lines.push(`+${g.hidden} more`)

  return lines
}
