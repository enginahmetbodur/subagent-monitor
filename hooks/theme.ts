// The design handoff's tokens, per surface. The desktop takes raw hex colors
// and SVG; the terminal follows the person's theme (theme keys) and glyphs.

export type Palette = {
  surface2?: string
  tile?: string
  chip?: string
  text: string
  text2: string
  muted: string
  off: string
  accent: string
  running: string
  ctx: string
  warn: string
  done: string
}

export const DESKTOP: Palette = {
  surface2: '#1C1C22',
  tile: '#1F1F25',
  chip: '#22222A',
  text: '#ECECEE',
  text2: '#CFCFD6',
  muted: '#A6A6B0',
  off: '#3A3A44',
  accent: '#E8915F',
  running: '#7FD4A0',
  ctx: '#6EA8FE',
  warn: '#F0B45A',
  done: '#5A5A64',
}

/** No backgrounds on the terminal: a dark tile would fight a light theme. */
export const TERMINAL: Palette = {
  text: 'text',
  text2: 'text',
  muted: 'subtle',
  off: 'inactive',
  accent: 'claude',
  running: 'success',
  ctx: 'suggestion',
  warn: 'warning',
  done: 'inactive',
}

export const WARN_PCT = 80

/** Background / foreground pairs, and the terminal's theme key for the foreground. */
type Swatch = { bg: string; fg: string; term: string }

const DEFAULT_SWATCH: Swatch = { bg: '#22222A', fg: '#CFCFD6', term: 'text' }

export const MODEL_SWATCH: Record<string, Swatch> = {
  opus: { bg: '#3A2A22', fg: '#F2B08A', term: 'claude' },
  sonnet: { bg: '#1F2C40', fg: '#9CC3FF', term: 'suggestion' },
  haiku: { bg: '#1F3328', fg: '#9BDDB5', term: 'success' },
}

export const modelSwatch = (family: string | undefined): Swatch =>
  (family !== undefined && MODEL_SWATCH[family]) || DEFAULT_SWATCH

// Stroke icons from the reference render (24x24 viewBox).
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  star: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5z"/><path d="M4 19a2 2 0 012-2h13"/>',
  circle: '<circle cx="12" cy="12" r="7"/>',
  list: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
}

export type TypeLook = Swatch & { short: string; icon: string; glyph: string }

const TYPES: Record<string, Omit<TypeLook, 'short'> & { short?: string }> = {
  Explore: { bg: '#1F2C40', fg: '#9CC3FF', term: 'suggestion', icon: ICON_PATHS.search, glyph: '⌕' },
  Plan: { bg: '#2E2440', fg: '#C7A2F5', term: 'planMode', icon: ICON_PATHS.map, glyph: '◇' },
  'general-purpose': { bg: '#3A2A22', fg: '#F2B08A', term: 'claude', icon: ICON_PATHS.star, glyph: '✳', short: 'General' },
  'claude-code-guide': { bg: '#1F3328', fg: '#9BDDB5', term: 'success', icon: ICON_PATHS.book, glyph: '❐', short: 'Guide' },
}

/** An unknown type keeps its own name (cut short) rather than the reference's generic "Agent". */
export const typeLook = (type: string): TypeLook => {
  const known = TYPES[type]
  const short = known?.short ?? (known ? type : type.length > 12 ? `${type.slice(0, 11)}…` : type || 'Agent')

  return known ? { ...known, short } : { ...DEFAULT_SWATCH, icon: ICON_PATHS.circle, glyph: '○', short }
}

const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

/** A 36x36 tile (radius 9) with the type's stroke icon centred at 18px. */
export const tileSvg = (look: TypeLook): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">` +
  `<rect width="36" height="36" rx="9" fill="${look.bg}"/>` +
  `<g transform="translate(9 9) scale(0.75)" fill="none" stroke="${look.fg}" stroke-width="1.9" ` +
  `stroke-linecap="round" stroke-linejoin="round">${look.icon}</g></svg>`

export const iconSvg = (name: 'list' | 'check', size: number, color: string, stroke: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`

/** The running dot: opacity 1 -> .35, 1.4s ease-in-out, forever (SMIL; needs an interactive Svg). */
export const pulseDotSvg = (color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6" viewBox="0 0 6 6">` +
  `<circle cx="3" cy="3" r="3" fill="${color}"><animate attributeName="opacity" values="1;.35;1" ` +
  `keyTimes="0;.5;1" calcMode="spline" keySplines=".42 0 .58 1;.42 0 .58 1" dur="1.4s" ` +
  `repeatCount="indefinite"/></circle></svg>`

/** A number set in the mono face at a size the cells cannot give (the 36px total, the 18px tokens). */
export const monoTextSvg = (text: string, size: number, color: string, anchor: 'start' | 'end'): string => {
  const width = Math.ceil(text.length * size * 0.62) + 2
  const height = Math.ceil(size * 1.15)
  const x = anchor === 'end' ? width : 0

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="${x}" y="${Math.round(size * 0.92)}" text-anchor="${anchor}" font-family="${MONO}" ` +
    `font-size="${size}" font-weight="500" fill="${color}">${text}</text></svg>`
  )
}

export const svgWidth = (source: string): number => Number(/width="(\d+)"/.exec(source)?.[1] ?? 0)
export const svgHeight = (source: string): number => Number(/height="(\d+)"/.exec(source)?.[1] ?? 0)

/** The handoff's effort meter: 5 segments 3px wide, 3 + i*1.5 px tall, 2px apart, bottom-aligned. */
export const effortSvg = (level: number, on: string, off: string): string => {
  const bars = [1, 2, 3, 4, 5]
    .map(i => {
      const h = 3 + i * 1.5

      return `<rect x="${(i - 1) * 5}" y="${11 - h}" width="3" height="${h}" rx="1" fill="${i <= level ? on : off}"/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="23" height="11" viewBox="0 0 23 11">${bars}</svg>`
}

/** A bar part: one filled rectangle 4000px wide (wider than any pane), `height` px tall. */
export const fillSvg = (height: number, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${height}" viewBox="0 0 4000 ${height}" ` +
  `preserveAspectRatio="none"><rect width="4000" height="${height}" fill="${color}"/></svg>`
