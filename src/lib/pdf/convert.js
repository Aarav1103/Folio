// Converts a PDF into an epub, entirely on the device.
//
// Per page: if the PDF has real text, that text is used. If the page is
// only a picture of text (a scan), it is recognised with OCR. Pictures
// are cut out and kept. Then the pages are cleaned up (running headers and
// page numbers removed, lines joined into paragraphs, headings found),
// grouped into chapters, and packaged as an epub.

import {
  pageToLines, stripRunning, bodyStats, linesToBlocks, mergeContinuations,
  placeFigures, ocrBlocksToLines, splitChapters, median,
} from './layout.js'
import { buildEpub } from './epub.js'
import { renderPage, canvasToJpeg, cropCanvas, releaseCanvas, inkFraction, findImageRects, detectScanFigures } from './render.js'
import { createOcr, languageInfo } from './ocr.js'

const MIN_TEXT_CHARS = 20 // fewer characters than this on a page means it is a picture of text, or blank
const OCR_DPI = 200

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new DOMException('Conversion cancelled', 'AbortError')
}

// Stopping the recognition worker kills it, which leaves a recognition in
// progress forever unresolved. So anything slow is raced against the cancel
// signal, and cancelling takes effect at once.
function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Conversion cancelled', 'AbortError'))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// pdf.js is large, so it is only loaded when a PDF is imported.
let pdfjsPromise = null
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // the "legacy" build runs on older phones as well
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })()
  }
  return pdfjsPromise
}

export async function openPdf(pdfjs, buffer) {
  // pdf.js takes ownership of the bytes it is given, so hand it a copy
  return pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false }).promise
}

// Looks at every page's text to learn which are scans, without converting anything.
export async function analyzePdf(pdf, { onProgress, signal } = {}) {
  const textChars = []
  for (let n = 1; n <= pdf.numPages; n++) {
    throwIfAborted(signal)
    const page = await pdf.getPage(n)
    const tc = await page.getTextContent()
    textChars.push(tc.items.reduce((sum, it) => sum + ('str' in it ? it.str.trim().length : 0), 0))
    page.cleanup()
    if (onProgress && n % 10 === 0) onProgress({ stage: 'reading', page: n, total: pdf.numPages })
  }
  const lowTextPages = textChars.map((c, i) => (c < MIN_TEXT_CHARS ? i + 1 : 0)).filter(Boolean)
  // A few picture-only pages in a normal book (plates) are kept as images.
  // Recognising text is for PDFs that are mostly scans.
  const ocrNeeded = lowTextPages.length >= 3 || lowTextPages.length >= pdf.numPages * 0.5

  let info = {}
  try { info = (await pdf.getMetadata()).info || {} } catch { /* no metadata */ }
  return {
    pageCount: pdf.numPages,
    textChars,
    lowTextPages,
    ocrNeeded,
    title: info.Title || '',
    author: info.Author || '',
    language: info.Language || '',
  }
}

// The PDF's bookmarks, as chapter starts: [{ page (0-based), title }].
async function readOutlineStarts(pdf) {
  let outline
  try { outline = await pdf.getOutline() } catch { return [] }
  if (!outline || !outline.length) return []
  // a single top-level entry (the book's title) with chapters beneath it
  let items = outline
  if (items.length <= 2 && items.some((i) => i.items && i.items.length >= 2)) {
    items = items.flatMap((i) => (i.items && i.items.length ? i.items : [i]))
  }
  const starts = []
  for (const item of items) {
    try {
      let dest = item.dest
      if (typeof dest === 'string') dest = await pdf.getDestination(dest)
      if (!Array.isArray(dest) || !dest[0]) continue
      const page = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0]
      if (Number.isInteger(page) && item.title && item.title.trim()) starts.push({ page, title: item.title.trim() })
    } catch { /* an unreadable bookmark is skipped */ }
  }
  return starts
}

// With no bookmarks, a page that opens with a big heading starts a chapter.
function headingStarts(blocks) {
  const starts = []
  const seen = new Set()
  for (const b of blocks) {
    if (seen.has(b.page)) continue
    seen.add(b.page)
    if (b.kind === 'h1') starts.push({ page: b.page, title: b.text })
  }
  return starts.length >= 3 ? starts : []
}

function usableTitle(title, fileName) {
  const t = (title || '').trim()
  const junk = /^(microsoft word|untitled|document\d*)\b|\.(docx?|pdf|indd|tex)$/i.test(t)
  if (t && !junk) return t
  return fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled'
}

// Cuts figures out of a rendered page, returning the figure records.
async function cutFigures(canvas, rects, scale, pageNumber, images) {
  const out = []
  let k = 0
  for (const r of rects) {
    k++
    const crop = cropCanvas(canvas, r.x0 * scale, r.y0 * scale, (r.x1 - r.x0) * scale, (r.y1 - r.y0) * scale)
    const blob = await canvasToJpeg(crop)
    releaseCanvas(crop)
    const name = `fig-${pageNumber}-${k}.jpg`
    images.set(name, { data: blob, type: 'image/jpeg' })
    out.push({ ...r, image: name, blob })
  }
  return out
}

// store: { getOcrPage(n), saveOcrPage(record) }, optional. Pages already in
// the store are not recognised again, which is what makes a job resumable.
export async function convertPdf({ pdf, pdfjs, analysis, fileName, language = 'eng', figures = true, onProgress, signal, store, identifier }) {
  const lang = languageInfo(language)
  const total = pdf.numPages
  const isTextPage = (n) => analysis.textChars[n - 1] >= MIN_TEXT_CHARS
  const ocrTotal = analysis.ocrNeeded ? analysis.lowTextPages.length : 0

  const pages = []
  const images = new Map()
  let ocr = null
  let ocrDone = 0
  let rtlChars = 0
  let allChars = 0

  try {
    for (let n = 1; n <= total; n++) {
      throwIfAborted(signal)
      const page = await pdf.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const entry = { kind: 'text', lines: [], height: vp.height, figures: [] }

      if (isTextPage(n)) {
        const tc = await page.getTextContent()
        const items = tc.items.filter((it) => 'str' in it).map((it) => {
          const t = pdfjs.Util.transform(vp.transform, it.transform)
          return { str: it.str, x: t[4], y: t[5], w: it.width, size: Math.hypot(t[0], t[1]), rtl: it.dir === 'rtl' }
        })
        for (const it of items) { allChars += it.str.length; if (it.rtl) rtlChars += it.str.length }
        entry.lines = pageToLines(items, vp.width)

        if (figures) {
          try {
            const rects = await findImageRects(page, vp, pdfjs)
            if (rects.length) {
              const widest = Math.max(...rects.map((r) => r.x1 - r.x0))
              const scale = Math.min(3, Math.max(1.5, 1100 / widest))
              const canvas = await renderPage(page, scale)
              entry.figures = await cutFigures(canvas, rects, scale, n, images)
              releaseCanvas(canvas)
            }
          } catch (err) {
            console.error(`Could not extract pictures from page ${n}`, err)
          }
        }
      } else if (analysis.ocrNeeded) {
        entry.kind = 'ocr'
        const saved = store ? await store.getOcrPage(n) : null
        if (saved) {
          entry.lines = saved.lines
          let k = 0
          for (const f of saved.figures) {
            k++
            const name = `fig-${n}-${k}.jpg`
            images.set(name, { data: f.blob, type: 'image/jpeg' })
            entry.figures.push({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, image: name, blob: f.blob })
          }
        } else {
          if (!ocr) {
            onProgress && onProgress({ stage: 'ocr-setup', status: 'starting', progress: 0 })
            const starting = createOcr(lang.code, { onStatus: (s) => onProgress && onProgress({ stage: 'ocr-setup', ...s }) })
            // a worker that finishes starting after a cancel must still be stopped
            starting.then((o) => { if (signal && signal.aborted) o.terminate() }, () => {})
            ocr = await abortable(starting, signal)
            if (signal) signal.addEventListener('abort', () => ocr && ocr.terminate(), { once: true })
          }
          const scale = Math.min(OCR_DPI / 72, 3200 / Math.max(vp.width, vp.height))
          const canvas = await renderPage(page, scale)
          try {
            const ink = inkFraction(canvas)
            if (ink >= 0.002) { // an empty page needs no recognition
              const blocks = await abortable(ocr.recognize(canvas), signal)
              entry.lines = ocrBlocksToLines(blocks, scale)
              if (figures) {
                const sizes = entry.lines.map((l) => l.size)
                const bodySize = sizes.length ? median(sizes) : 11
                let rects = detectScanFigures(canvas, entry.lines, scale, bodySize)
                if (!rects.length && entry.lines.length <= 1 && ink >= 0.08) {
                  rects = [{ x0: 0, y0: 0, x1: vp.width, y1: vp.height }] // a picture-only page (a plate)
                }
                entry.figures = await cutFigures(canvas, rects, scale, n, images)
              }
            }
          } finally {
            releaseCanvas(canvas)
          }
          if (store) {
            await store.saveOcrPage({
              page: n,
              lines: entry.lines,
              figures: entry.figures.map((f) => ({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, blob: f.blob })),
            })
          }
        }
        ocrDone++
      } else {
        // a picture-only page in an otherwise normal book: keep it as an image
        entry.kind = 'plate'
        const canvas = await renderPage(page, 1.5)
        if (inkFraction(canvas) >= 0.01 && figures) {
          entry.figures = await cutFigures(canvas, [{ x0: 0, y0: 0, x1: vp.width, y1: vp.height }], 1.5, n, images)
        }
        releaseCanvas(canvas)
      }

      pages.push(entry)
      page.cleanup()
      onProgress && onProgress({ stage: 'converting', page: n, total, ocrDone, ocrTotal })
    }
  } finally {
    if (ocr) await ocr.terminate().catch(() => {})
  }

  throwIfAborted(signal)
  onProgress && onProgress({ stage: 'building', page: total, total, ocrDone, ocrTotal })

  // clean up and structure the text
  const rtl = lang.rtl || (allChars > 0 && rtlChars / allChars > 0.5)
  const stats = {
    text: bodyStats(pages.filter((p) => p.kind === 'text').map((p) => p.lines)),
    ocr: bodyStats(pages.filter((p) => p.kind === 'ocr').map((p) => p.lines)),
  }
  const stripped = stripRunning(pages.map((p) => ({ lines: p.lines, height: p.height })))
  const blocks = []
  pages.forEach((p, i) => {
    let b = linesToBlocks(stripped[i].lines, stats[p.kind] || stats.text).map((x) => ({ ...x, page: i }))
    if (p.figures.length) b = placeFigures(b, p.figures, i)
    blocks.push(...b)
  })
  const merged = mergeContinuations(blocks)

  let starts = await readOutlineStarts(pdf)
  if (starts.length < 2) starts = headingStarts(merged)
  const chapters = splitChapters(merged, { pageCount: total, starts })
  if (!chapters.length) throw new Error('No text could be read from this PDF.')

  let cover = null
  try {
    const p1 = await pdf.getPage(1)
    const v = p1.getViewport({ scale: 1 })
    const canvas = await renderPage(p1, Math.min(2, 480 / v.width))
    cover = { data: await canvasToJpeg(canvas, 0.8), type: 'image/jpeg' }
    releaseCanvas(canvas)
  } catch { /* a book without a cover is fine */ }

  const title = usableTitle(analysis.title, fileName)
  const blob = await buildEpub({
    title,
    author: analysis.author,
    language: analysis.ocrNeeded ? lang.bcp47 : (analysis.language || lang.bcp47),
    rtl,
    chapters,
    images,
    cover,
    identifier,
  })
  return { blob, title, author: analysis.author, pageCount: total, ocrPages: ocrDone, chapterCount: chapters.length }
}
