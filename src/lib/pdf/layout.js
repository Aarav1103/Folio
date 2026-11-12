// Turns positioned text from a PDF page (or from OCR) into clean paragraphs.
//
// This file is pure logic with no browser or pdf.js dependencies, so it can
// be tested on its own. Its input is a list of "text items" and its output
// is paragraphs and headings in reading order.
//
// Coordinates are page coordinates in points (or pixels, for OCR), with y
// growing downward and `y` being a text baseline.
//
//   item: { str, x, y, w, size, bold?, rtl? }       one run of text
//   line: { text, x0, x1, y, size, bold, flow, par? } one visual line of text
//   block: { kind: 'p' | 'h1' | 'h2', text, ... }    a paragraph or heading
//
// "flow" says which column (or OCR block) a line belongs to. Lines in
// different flows are never merged into one paragraph here, a paragraph that
// continues from one column to the next is rejoined later (mergeContinuations).

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' }
// Built from char codes so no invisible characters sit in the source.
const NBSP = String.fromCharCode(0xa0)
const SOFT_HYPHEN = String.fromCharCode(0xad)
const SENTENCE_END = /[.!?…:;)\]"'”’»]\s*$/

export function median(values) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function cleanText(str) {
  return str
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c)
    .split(NBSP).join(' ')
    .replace(/[\t ]+/g, ' ')
}

// ---------------------------------------------------------------------------
// Items -> lines, with two-column detection
// ---------------------------------------------------------------------------

// Looks for a vertical channel of empty space near the middle of the page
// with real text on both sides, which means the page is set in two columns.
function findGutter(words, pageW) {
  if (words.length < 16) return null
  const BINS = 240
  const binW = pageW / BINS
  const cover = new Float64Array(BINS)
  for (const it of words) {
    const a = Math.max(0, Math.floor(it.x / binW))
    const b = Math.min(BINS - 1, Math.floor((it.x + it.w) / binW))
    for (let i = a; i <= b; i++) cover[i]++
  }
  const maxCover = Math.max(...cover)
  const tolerance = Math.max(1, Math.floor(maxCover * 0.04)) // a few full-width lines (a title) are fine
  const lo = Math.floor(BINS * 0.3)
  const hi = Math.floor(BINS * 0.7)

  let best = null
  let runStart = -1
  for (let i = lo; i <= hi + 1; i++) {
    const empty = i <= hi && cover[i] <= tolerance
    if (empty && runStart < 0) runStart = i
    if (!empty && runStart >= 0) {
      const len = i - runStart
      if (!best || len > best.len) best = { start: runStart, len }
      runStart = -1
    }
  }
  if (!best || best.len * binW < pageW * 0.02) return null

  const g0 = best.start * binW
  const g1 = (best.start + best.len) * binW
  const mid = (g0 + g1) / 2
  let left = 0
  let right = 0
  for (const it of words) {
    if (it.x + it.w / 2 < mid) left += it.str.length
    else right += it.str.length
  }
  const total = left + right
  if (left < total * 0.25 || right < total * 0.25) return null
  return { g0, g1, mid }
}

// Groups items that share a baseline into rows.
function groupRows(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(it.y - row.y) <= 0.5 * Math.max(row.size, it.size)) {
      row.y = (row.y * row.n + it.y) / (row.n + 1)
      row.n++
      row.size = Math.max(row.size, it.size)
      row.items.push(it)
    } else {
      rows.push({ items: [it], y: it.y, size: it.size, n: 1 })
    }
  }
  return rows
}

function rowToLine(row, flow) {
  const items = row.items
  const totalChars = items.reduce((n, i) => n + i.str.length, 0)
  const rtlChars = items.filter((i) => i.rtl).reduce((n, i) => n + i.str.length, 0)
  const isRtl = rtlChars > totalChars / 2
  items.sort((a, b) => (isRtl ? b.x - a.x : a.x - b.x))

  let text = ''
  let prev = null
  for (const it of items) {
    if (prev) {
      const gap = isRtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w)
      const ref = Math.max(prev.size, it.size)
      const alreadySpaced = /\s$/.test(text) || /^\s/.test(it.str)
      if (!alreadySpaced && gap > 0.12 * ref) text += ' '
    }
    text += it.str
    prev = it
  }

  // the size that covers the most characters, and whether most text is bold
  const bySize = new Map()
  let boldChars = 0
  for (const it of items) {
    const key = Math.round(it.size * 10) / 10
    bySize.set(key, (bySize.get(key) || 0) + it.str.length)
    if (it.bold) boldChars += it.str.length
  }
  const size = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0]

  return {
    text: cleanText(text).trim(),
    x0: Math.min(...items.map((i) => i.x)),
    x1: Math.max(...items.map((i) => i.x + i.w)),
    y: row.y,
    size,
    bold: boldChars > totalChars / 2,
    flow,
  }
}

// All the lines of one page, in reading order. A page set in two columns
// reads the whole left column, then the whole right one, with any full-width
// lines (a title) kept in place between them.
export function pageToLines(items, pageW) {
  const words = items.filter((it) => it.str && it.str.trim())
  if (!words.length) return []

  const gutter = findGutter(words, pageW)
  if (!gutter) {
    return groupRows(words).map((r) => rowToLine(r, 0))
  }

  const full = []
  const cols = [[], []]
  for (const it of words) {
    if (it.x < gutter.g0 && it.x + it.w > gutter.g1) full.push(it)
    else cols[it.x + it.w / 2 < gutter.mid ? 0 : 1].push(it)
  }
  const lines = [
    ...groupRows(full).map((r) => rowToLine(r, 'full')),
    ...groupRows(cols[0]).map((r) => rowToLine(r, 1)),
    ...groupRows(cols[1]).map((r) => rowToLine(r, 2)),
  ].sort((a, b) => a.y - b.y)

  const ordered = []
  let left = []
  let right = []
  const flush = () => { ordered.push(...left, ...right); left = []; right = [] }
  for (const ln of lines) {
    if (ln.flow === 'full') { flush(); ordered.push(ln) }
    else if (ln.flow === 1) left.push(ln)
    else right.push(ln)
  }
  flush()
  return ordered
}

// ---------------------------------------------------------------------------
// Running headers, footers and page numbers
// ---------------------------------------------------------------------------

const PAGE_NUMBER = /^[\s\-–—•.[\]()]*([0-9]{1,4}|[ivxlcdm]{1,7})[\s\-–—•.[\]()]*$/i

function runningKey(text) {
  return text.toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim()
}

// Removes page numbers and text that repeats at the top or bottom of many
// pages. `pages` is [{ lines, height }], the result has the same shape.
export function stripRunning(pages) {
  const inMargin = (ln, h) => ln.y < h * 0.1 || ln.y > h * 0.9
  const seenOnPages = new Map() // key -> Set of page indexes
  pages.forEach((p, pi) => {
    for (const ln of p.lines) {
      if (!inMargin(ln, p.height) || !ln.text) continue
      const key = runningKey(ln.text)
      if (!seenOnPages.has(key)) seenOnPages.set(key, new Set())
      seenOnPages.get(key).add(pi)
    }
  })
  const needed = Math.max(2, Math.ceil(pages.length * 0.3))
  const repeated = new Set(
    [...seenOnPages.entries()].filter(([key, set]) => set.size >= needed && key.replace(/#/g, '').length >= 2).map(([key]) => key)
  )
  return pages.map((p) => ({
    ...p,
    lines: p.lines.filter((ln) => {
      if (!inMargin(ln, p.height)) return true
      if (PAGE_NUMBER.test(ln.text)) return false
      return !repeated.has(runningKey(ln.text))
    }),
  }))
}

// ---------------------------------------------------------------------------
// Lines -> paragraphs and headings
// ---------------------------------------------------------------------------

// The most common text size, the usual distance between lines, and whether
// the book marks new paragraphs with an indent. `pageLines` is one array of
// lines per page.
export function bodyStats(pageLines) {
  const allLines = pageLines.flat()
  const chars = new Map()
  for (const ln of allLines) {
    const key = Math.round(ln.size * 2) / 2
    chars.set(key, (chars.get(key) || 0) + ln.text.length)
  }
  const bodySize = chars.size ? [...chars.entries()].sort((a, b) => b[1] - a[1])[0][0] : 12

  const gaps = []
  for (let i = 1; i < allLines.length; i++) {
    const d = allLines[i].y - allLines[i - 1].y
    if (allLines[i].flow === allLines[i - 1].flow && d > bodySize * 0.9 && d < bodySize * 2.2) gaps.push(d)
  }

  // Count lines that start further in than the line before them. If that
  // happens every so often, paragraphs are marked by indents, and a short
  // line that ends a sentence is NOT enough to say a paragraph ended.
  let indentStarts = 0
  let counted = 0
  for (const lines of pageLines) {
    for (const flow of new Set(lines.map((l) => l.flow))) {
      const group = lines.filter((l) => l.flow === flow && Math.abs(l.size - bodySize) <= bodySize * 0.15)
      if (group.length < 2) continue
      const left = leftMargin(group)
      for (let i = 1; i < group.length; i++) {
        counted++
        const step = group[i].x0 - left
        if (step > bodySize * 0.9 && step < bodySize * 5 && group[i - 1].x0 - left <= bodySize * 0.9) indentStarts++
      }
    }
  }
  return {
    bodySize,
    leading: gaps.length ? median(gaps) : bodySize * 1.2,
    usesIndents: counted > 0 && indentStarts / counted >= 0.04,
  }
}

const LOWER_START = /^[a-zß-öø-ÿ]/

// Joins wrapped lines into one string, rejoining words split with a hyphen
// at the end of a line.
export function joinText(a, b, noSpaces = false) {
  if (!a) return b
  if (!b) return a
  if (a.endsWith(SOFT_HYPHEN)) return a.slice(0, -1) + b
  if (/[A-Za-zÀ-ɏ]-$/.test(a) && LOWER_START.test(b)) return a.slice(0, -1) + b
  return noSpaces ? a + b : a + ' ' + b
}

function leftMargin(lines) {
  const counts = new Map()
  for (const ln of lines) {
    const key = Math.round(ln.x0)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// Turns the lines of one page into paragraphs and headings. `stats` come
// from bodyStats() over the whole document.
export function linesToBlocks(lines, stats, { noSpaces = false } = {}) {
  const { bodySize, leading } = stats
  const isHeading = (ln) => ln.size >= bodySize * 1.18 && ln.text.length <= 140
  const level = (ln) => (ln.size >= bodySize * 1.6 ? 'h1' : 'h2')

  // each flow's left margin and right edge, to tell indents and short last lines
  const margins = new Map()
  for (const flow of new Set(lines.map((l) => l.flow))) {
    const body = lines.filter((l) => l.flow === flow && !isHeading(l))
    if (!body.length) continue
    const xs = body.map((l) => l.x1).sort((a, b) => a - b)
    margins.set(flow, { left: leftMargin(body), right: xs[Math.floor(xs.length * 0.9)] })
  }

  const blocks = []
  let cur = null
  const close = () => {
    if (!cur) return
    let text = cur.lines[0].text
    for (let i = 1; i < cur.lines.length; i++) text = joinText(text, cur.lines[i].text, noSpaces)
    const first = cur.lines[0]
    const last = cur.lines[cur.lines.length - 1]
    const m = margins.get(first.flow)
    const width = m ? Math.max(1, m.right - m.left) : 1
    blocks.push({
      kind: cur.kind,
      text,
      flow: first.flow,
      y0: first.y - first.size,
      y1: last.y,
      x0: Math.min(...cur.lines.map((l) => l.x0)),
      x1: Math.max(...cur.lines.map((l) => l.x1)),
      size: first.size,
      // used to tell, across a page or column break, a paragraph that
      // continues from one that ended: new paragraphs are often indented,
      // and a paragraph that ends mid-page-break usually has a full last line
      indented: !!m && first.x0 - m.left > bodySize * 0.9,
      lastFull: !!m && last.x1 >= m.right - width * 0.12,
    })
    cur = null
  }

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const prev = lines[i - 1]
    const heading = isHeading(ln)
    let startNew = !cur

    if (cur) {
      if (heading !== (cur.kind !== 'p')) startNew = true
      else if (prev.flow !== ln.flow) startNew = true
      else if (heading) {
        const sameStyle = Math.abs(prev.size - ln.size) < prev.size * 0.06 && ln.y - prev.y < ln.size * 1.7
        startNew = !sameStyle
      } else if (prev.par !== undefined && ln.par !== undefined) {
        startNew = prev.par !== ln.par // OCR already decided where paragraphs break
      } else {
        const m = margins.get(ln.flow) || { left: ln.x0, right: ln.x1 }
        const width = Math.max(1, m.right - m.left)
        const extraSpace = ln.y - prev.y > leading * 1.45
        const indented = ln.x0 - prev.x0 > bodySize * 0.9
        const shortThenNew = !stats.usesIndents && prev.x1 < m.right - width * 0.2 && SENTENCE_END.test(prev.text)
        startNew = extraSpace || indented || shortThenNew
      }
    }

    if (startNew) {
      close()
      cur = { kind: heading ? level(ln) : 'p', lines: [ln] }
    } else {
      cur.lines.push(ln)
    }
  }
  close()
  return blocks
}

// Rejoins a paragraph that was split by a page break or a column break.
// `blocks` carry `page` and `flow`.
export function mergeContinuations(blocks, { noSpaces = false } = {}) {
  // A book that indents its paragraphs gives a strong hint: a block that is
  // NOT indented, right after a full last line, is the same paragraph
  // carrying on. (Not used for books that separate paragraphs by spacing.)
  const paras = blocks.filter((b) => b.kind === 'p')
  const indentedStyle = paras.length > 0 && paras.filter((b) => b.indented).length / paras.length >= 0.5

  const out = []
  for (const b of blocks) {
    const a = out[out.length - 1]
    const brokenHere = a && (a.page !== b.page || a.flow !== b.flow)
    const continues =
      brokenHere && a.kind === 'p' && b.kind === 'p' &&
      (/[A-Za-zÀ-ɏ]-$/.test(a.text) ||
        (!SENTENCE_END.test(a.text) && LOWER_START.test(b.text)) ||
        (indentedStyle && !b.indented && a.lastFull))
    if (continues) {
      a.text = joinText(a.text, b.text, noSpaces)
      a.y1 = b.y1
      a.lastFull = b.lastFull
    } else {
      out.push({ ...b })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

// Puts figures into a page's blocks at the right vertical position. A figure
// goes before the first block that starts below its top edge and sits in the
// same horizontal span (so a figure in one column is not placed by the other
// column's text). Figures with no later block go at the end.
export function placeFigures(blocks, figures, page) {
  const out = [...blocks]
  for (const fig of [...figures].sort((a, b) => a.y0 - b.y0)) {
    const overlaps = (b) => Math.min(b.x1, fig.x1) - Math.max(b.x0, fig.x0) > 0.3 * Math.min(b.x1 - b.x0, fig.x1 - fig.x0)
    let at = out.findIndex((b) => b.kind !== 'img' && b.y0 >= fig.y0 - 1 && overlaps(b))
    if (at < 0) at = out.length
    out.splice(at, 0, { kind: 'img', imageName: fig.image, alt: fig.alt || '', y0: fig.y0, y1: fig.y1, x0: fig.x0, x1: fig.x1, flow: 0, page })
  }
  return out
}

// ---------------------------------------------------------------------------
// OCR output -> lines
// ---------------------------------------------------------------------------

// Converts Tesseract's blocks (block > paragraph > line, with pixel boxes)
// into the same line shape pageToLines makes, in points. `scale` is the
// pixels-per-point the page was rendered at. Tesseract already decided the
// reading order (one flow per block) and where paragraphs start (`par`).
export function ocrBlocksToLines(blocks, scale = 1, { minConfidence = 35 } = {}) {
  const lines = []
  blocks.forEach((block, bi) => {
    ;(block.paragraphs || []).forEach((para, pi) => {
      for (const line of para.lines || []) {
        const text = cleanText(String(line.text || '')).trim()
        // junk from images and page edges tends to be low confidence, or has no letters
        if (!text || !/[\p{L}\p{N}]/u.test(text)) continue
        if (typeof line.confidence === 'number' && line.confidence < minConfidence) continue

        // text size from the taller words, so a line without capitals or
        // descenders is not mistaken for smaller text
        const heights = (line.words || []).map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b)
        const tall = heights.length ? heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.8))] : line.bbox.y1 - line.bbox.y0
        const base = line.baseline && line.baseline.y0 != null ? (line.baseline.y0 + line.baseline.y1) / 2 : line.bbox.y1

        lines.push({
          text,
          x0: line.bbox.x0 / scale,
          x1: line.bbox.x1 / scale,
          y: base / scale,
          size: Math.round((tall / scale) * 10) / 10,
          bold: false,
          flow: bi,
          par: `${bi}:${pi}`,
        })
      }
    })
  })
  return lines
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

// Splits blocks (each with a 0-based `page`) into chapters. `starts` is
// [{ page, title }], from the PDF's bookmarks or its big headings. With no
// usable starts the book is cut into runs of `chunk` pages, since the
// reader loads and tracks progress one chapter at a time. A chapter longer
// than `maxPages` is cut into parts.
export function splitChapters(blocks, { pageCount, starts = [], chunk = 10, maxPages = 40 }) {
  const ranges = []
  const sorted = [...starts].sort((a, b) => a.page - b.page).filter((s, i, a) => i === 0 || s.page !== a[i - 1].page)

  if (sorted.length >= 2) {
    if (sorted[0].page > 0) ranges.push({ from: 0, to: sorted[0].page, title: 'Front matter' })
    sorted.forEach((s, i) => ranges.push({ from: s.page, to: i + 1 < sorted.length ? sorted[i + 1].page : pageCount, title: s.title }))
  } else {
    for (let from = 0; from < pageCount; from += chunk) {
      const to = Math.min(pageCount, from + chunk)
      ranges.push({ from, to, title: to - from === 1 ? `Page ${from + 1}` : `Pages ${from + 1} to ${to}` })
    }
  }

  const chapters = []
  for (const r of ranges) {
    const parts = Math.max(1, Math.ceil((r.to - r.from) / maxPages))
    const per = Math.ceil((r.to - r.from) / parts)
    for (let p = 0; p < parts; p++) {
      const from = r.from + p * per
      const to = Math.min(r.to, from + per)
      const inRange = blocks.filter((b) => b.page >= from && b.page < to)
      if (!inRange.length) continue
      chapters.push({ title: parts > 1 ? `${r.title} (part ${p + 1})` : r.title, blocks: inRange })
    }
  }
  return chapters
}
