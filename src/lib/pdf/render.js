// Browser-side helpers for drawing PDF pages, finding the pictures in them,
// and cutting those pictures out as JPEGs. Needs a DOM (canvas).
//
// Rectangles are { x0, y0, x1, y1 } in PDF points at scale 1, with y growing
// downward, the same space the text layout uses.

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  return canvas
}

// Safari keeps canvas memory around until the size is zeroed.
export function releaseCanvas(canvas) {
  canvas.width = 0
  canvas.height = 0
}

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale })
  const canvas = makeCanvas(viewport.width, viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, canvas, viewport }).promise
  return canvas
}

export function canvasToJpeg(canvas, quality = 0.82) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/jpeg', quality)
  })
}

// Copies a rectangle (in canvas pixels) to a new canvas, shrunk if wider than maxWidth.
export function cropCanvas(src, x, y, w, h, maxWidth = 1200) {
  x = Math.max(0, Math.floor(x))
  y = Math.max(0, Math.floor(y))
  w = Math.min(src.width - x, Math.ceil(w))
  h = Math.min(src.height - y, Math.ceil(h))
  const k = Math.min(1, maxWidth / w)
  const out = makeCanvas(w * k, h * k)
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height)
  return out
}

// Fraction of (sampled) pixels that are dark enough to count as ink.
export function inkFraction(canvas, threshold = 190) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let ink = 0
  let seen = 0
  for (let p = 0; p < data.length; p += 4 * 4) { // every 4th pixel is plenty
    seen++
    if ((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 < threshold) ink++
  }
  return seen ? ink / seen : 0
}

// ---------------------------------------------------------------------------
// Pictures inside a text PDF
// ---------------------------------------------------------------------------

function unionRects(rects, gap = 3) {
  const out = rects.map((r) => ({ ...r }))
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i]
        const b = out[j]
        if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
          out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
          out.splice(j, 1)
          merged = true
        }
      }
    }
  }
  return out
}

// Walks the page's drawing commands, tracking the transform, to find where
// images are painted. Skips tiny ones (rules, bullets) and any that cover
// nearly the whole page (a scan's background). A picture cut into strips is
// joined back together. Pictures drawn as vector graphics are not found.
export async function findImageRects(page, viewport, { OPS, Util }) {
  const list = await page.getOperatorList()
  const imageOps = new Set(
    [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => v !== undefined)
  )
  const stack = []
  let ctm = viewport.transform.slice()
  const found = []

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]
    const args = list.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() || ctm
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (Array.isArray(args) && Array.isArray(args[0])) ctm = Util.transform(ctm, args[0])
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm
    else if (imageOps.has(fn)) {
      const [a, b, c, d, e, f] = ctm
      const xs = [e, a + e, c + e, a + c + e]
      const ys = [f, b + f, d + f, b + d + f]
      found.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) })
    }
  }

  const pageArea = viewport.width * viewport.height
  return unionRects(found)
    .map((r) => ({
      x0: Math.max(0, r.x0), y0: Math.max(0, r.y0),
      x1: Math.min(viewport.width, r.x1), y1: Math.min(viewport.height, r.y1),
    }))
    .filter((r) => {
      const w = r.x1 - r.x0
      const h = r.y1 - r.y0
      return w >= 40 && h >= 30 && w * h >= pageArea * 0.01 && w * h <= pageArea * 0.8
    })
}

// ---------------------------------------------------------------------------
// Pictures on a scanned page
// ---------------------------------------------------------------------------

// Tesseract does not report where pictures are, so they are found from the
// page image: a tall vertical gap between lines of recognised text that is
// not blank is a picture. `lines` are in points, the canvas is `scale`
// pixels per point. Returns rectangles in points.
export function detectScanFigures(canvas, lines, scale, bodySize) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const W = canvas.width
  const H = canvas.height
  const sorted = [...lines].sort((a, b) => a.y - b.y)
  const tops = [0, ...sorted.map((l) => (l.y + l.size * 0.35) * scale)]
  const bottoms = [...sorted.map((l) => (l.y - l.size * 0.9) * scale), H]
  const minGap = Math.max(bodySize * 3.5, 36) * scale
  const out = []

  for (let i = 0; i < tops.length; i++) {
    const y = Math.max(0, tops[i])
    const h = Math.min(H, bottoms[i]) - y
    if (h < minGap) continue

    const x = Math.floor(W * 0.05)
    const w = Math.floor(W * 0.9)
    const { data } = ctx.getImageData(x, Math.floor(y), w, Math.floor(h))
    const rows = Math.floor(h)
    const rowInk = new Uint32Array(rows)
    const colInk = new Uint32Array(w)
    for (let j = 0; j < rows; j += 2) {
      for (let k = 0; k < w; k += 2) {
        const p = (j * w + k) * 4
        if ((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 < 190) { rowInk[j]++; colInk[k]++ }
      }
    }
    const rowMin = Math.max(2, (w / 2) * 0.004)
    const colMin = Math.max(2, (rows / 2) * 0.004)
    let top = -1, bottom = -1, left = -1, right = -1
    for (let j = 0; j < rows; j++) if (rowInk[j] >= rowMin) { if (top < 0) top = j; bottom = j }
    for (let k = 0; k < w; k++) if (colInk[k] >= colMin) { if (left < 0) left = k; right = k }
    if (top < 0 || left < 0) continue

    const boxW = right - left
    const boxH = bottom - top
    let inked = 0
    for (let j = top; j <= bottom; j += 2) inked += rowInk[j]
    const density = inked / Math.max(1, (boxW / 2) * (boxH / 2))
    if (boxW < 40 * scale || boxH < 40 * scale || density < 0.03) continue
    if (boxW * boxH < W * H * 0.01) continue

    const pad = 6
    out.push({
      x0: (x + left - pad) / scale,
      y0: (y + top - pad) / scale,
      x1: (x + right + pad) / scale,
      y1: (y + bottom + pad) / scale,
    })
  }
  return out
}
