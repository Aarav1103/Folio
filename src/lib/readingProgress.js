// How much of a book has been read, as a whole number from 0 to 100.
//
// Chapters differ a lot in length (in one real epub the shortest was 435 bytes and
// the longest 64,000), so counting every chapter the same gave a percentage that
// was off by up to 15 points. Each chapter counts for its share of the book instead.
//
// A chapter's length is estimated by the size of its file inside the epub. That is
// read from the epub's file index (the zip's table of contents), so nothing has to be
// unpacked and the whole book does not have to be loaded: on that same epub the
// estimate was off by 1.3 points at worst (0.3 on average). The exact answer, from
// counting the letters in every chapter, would mean reading the whole book first.
//
// Where a chapter's size cannot be told, it is given the typical (median) size of the
// others. If no size is known at all every chapter counts the same, as it used to.

// Every chapter counts for at least this much: a cover page or an image-only page
// is a real step through the book, even though its file is tiny.
export const MIN_CHAPTER_WEIGHT = 1000

// sizes: one number per chapter, in reading order (undefined, NaN or 0 where unknown).
// Returns the weight of each chapter, or an empty list if there are no chapters.
export function chapterWeights(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return []
  const known = sizes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b)
  const median = known.length ? known[Math.floor(known.length / 2)] : 1
  return sizes.map((s) => Math.max(Number.isFinite(s) && s > 0 ? s : median, MIN_CHAPTER_WEIGHT))
}

// index: the chapter at the top of the screen (0-based), fraction: how far down it (0 to 1).
// chapterCount is used when there are no usable weights (or they do not match the chapters).
export function overallPercent(weights, index, fraction, chapterCount) {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const usable = Array.isArray(weights) && weights.length > 0 && (!chapterCount || weights.length === chapterCount)
  const count = usable ? weights.length : chapterCount
  if (!count) return 0
  const i = Math.min(count - 1, Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0))
  if (!usable) return Math.min(100, Math.round(((i + f) / count) * 100))
  let before = 0
  let total = 0
  for (let k = 0; k < count; k++) {
    if (k < i) before += weights[k]
    total += weights[k]
  }
  return Math.min(100, Math.round(((before + f * weights[i]) / total) * 100))
}
