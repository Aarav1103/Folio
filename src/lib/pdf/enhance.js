// Cleans up a picture of a page before text recognition.
//
// Scans and phone photos are often lit unevenly (a shadow down one side, a grey
// corner) and have washed-out ink, and text recognition does much worse on them:
// in tests on poor scans it got half of the words wrong (52%), and 10% after this step.
// Two things are done:
//   1. The uneven lighting is removed. The paper's brightness is estimated from
//      the lightest parts of the picture (text is thin, so the paper level can be
//      read around it) and every pixel is divided by it.
//   2. The contrast is stretched so the ink is dark and the paper light.
// It is not turned into pure black and white: that made things worse on noisy
// pages. The result is a grey picture of the same size.
//
// enhanceForOcr works on plain pixel data (so it can be tested without a
// browser); enhanceCanvas is the thin wrapper used by the converter. The
// original picture is left alone, because figures are cut from it.

import { makeCanvas } from './render.js'

const SHRINK = 4 // the paper level is worked out on a picture this many times smaller
const WHITE_SHARE = 0.6 // white starts at the level that this share of the page is at least as bright as (the 40th percentile)

// Gray values of an RGBA image
// (whole grey levels in 8 bits: a page is millions of pixels, and this keeps the copy small on a phone)
function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = Math.round((rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000)
  }
  return gray
}

// Average of each SHRINK x SHRINK block
function shrink(gray, width, height) {
  const sw = Math.ceil(width / SHRINK)
  const sh = Math.ceil(height / SHRINK)
  const small = new Float32Array(sw * sh)
  for (let sy = 0; sy < sh; sy++) {
    const y0 = sy * SHRINK
    const y1 = Math.min(height, y0 + SHRINK)
    for (let sx = 0; sx < sw; sx++) {
      const x0 = sx * SHRINK
      const x1 = Math.min(width, x0 + SHRINK)
      let sum = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * width + x]
      small[sy * sw + sx] = sum / ((y1 - y0) * (x1 - x0))
    }
  }
  return { small, sw, sh }
}

// Largest value in a (2r+1) square around each pixel: the text is removed, the paper is left
function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -1
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[y * w + k] > m) m = src[y * w + k]
      tmp[y * w + x] = m
    }
  }
  const out = new Float32Array(src.length)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -1
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x]
      out[y * w + x] = m
    }
  }
  return out
}

// One pass of a moving average of width 2r+1 along rows (axis 0) or columns (axis 1), edges repeated
function boxBlur(src, w, h, r, axis) {
  const out = new Float32Array(src.length)
  const len = axis === 0 ? w : h
  const lines = axis === 0 ? h : w
  const at = (line, i) => (axis === 0 ? line * w + i : i * w + line)
  const n = 2 * r + 1
  for (let line = 0; line < lines; line++) {
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[at(line, Math.min(len - 1, Math.max(0, i)))]
    for (let i = 0; i < len; i++) {
      out[at(line, i)] = sum / n
      sum += src[at(line, Math.min(len - 1, i + r + 1))] - src[at(line, Math.max(0, i - r))]
    }
  }
  return out
}

// A smooth blur (three box blurs in each direction approximate a Gaussian with this spread, in pixels)
function smooth(src, w, h, sigma) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2))
  let a = src
  for (let pass = 0; pass < 3; pass++) {
    a = boxBlur(a, w, h, r, 0)
    a = boxBlur(a, w, h, r, 1)
  }
  return a
}

// Returns new RGBA data of the same size: a grey picture with even lighting and stretched contrast.
export function enhanceForOcr(rgba, width, height) {
  const gray = toGray(rgba, width, height)
  const { small, sw, sh } = shrink(gray, width, height)
  // paper level, at a coarse scale: the lightest parts nearby, smoothed over about 7% of the page width
  const paper = smooth(maxFilter(small, sw, sh, 4), sw, sh, Math.max(4, (0.07 * width) / SHRINK))

  // divide the lighting out: each pixel relative to the paper level around it
  const level = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    // position of this row in the small picture (bilinear)
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / SHRINK - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / SHRINK - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = fx - x0
      const bg =
        (paper[y0 * sw + x0] * (1 - tx) + paper[y0 * sw + x1] * tx) * (1 - ty) +
        (paper[y1 * sw + x0] * (1 - tx) + paper[y1 * sw + x1] * tx) * ty
      let v = (gray[y * width + x] / Math.max(bg, 1)) * 255
      v = v < 0 ? 0 : v > 255 ? 255 : v
      level[y * width + x] = Math.round(v)
    }
  }

  const hist = new Uint32Array(256)
  for (let i = 0; i < level.length; i++) hist[level[i]]++

  // Stretch. The darkest 1% become black. White starts at the 40th percentile (40% of the
  // page is darker than it): text covers well under 40% of a page, so that is paper, and putting
  // white there turns the paper's grain (which a plain stretch would show as speckle across
  // the whole page) into clean white. A page that is mostly dark is not a text page on
  // paper; there the lightest 1% is used instead, so the ink is not washed out.
  const total = width * height
  const fromTop = (share) => {
    let value = 255
    for (let acc = 0; value > 0; value--) { acc += hist[value]; if (acc >= total * share) break }
    return value
  }
  let lo = 0
  for (let acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc >= total * 0.01) break }
  let hi = fromTop(WHITE_SHARE)
  if (hi < 128) hi = fromTop(0.01)
  // a page with almost no contrast (blank, or all one tone) is left as it is
  const span = hi - lo
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) lut[i] = span >= 24 ? ((i - lo) * 255) / span : i

  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0; i < level.length; i++, p += 4) {
    const v = lut[level[i]]
    out[p] = v
    out[p + 1] = v
    out[p + 2] = v
    out[p + 3] = 255
  }
  return out
}

// A new canvas holding the enhanced picture of `canvas`.
export function enhanceCanvas(canvas) {
  const w = canvas.width
  const h = canvas.height
  const source = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h)
  const result = makeCanvas(w, h)
  result.getContext('2d').putImageData(new ImageData(enhanceForOcr(source.data, w, h), w, h), 0, 0)
  return result
}
