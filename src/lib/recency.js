// Ordering of the library by recency.
//
// A book's "last touched" time is the later of when it was added and when it
// was last read, so a book you opened today sits above one you added last week
// and never opened. Newest first; books with the same time go by title so the
// order is stable.

// `addedAt` is a number (Date.now()) for a book added on this device, but an
// ISO string (the row's created_at) for one that arrived through sync. Progress
// `updatedAt` is a number. Anything unreadable counts as "long ago".
export function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

export function lastTouched(book, progress) {
  return Math.max(toMillis(book.addedAt), toMillis(progress && progress.updatedAt))
}

export function sortByRecency(books, progressMap = {}) {
  return [...books].sort(
    (a, b) =>
      lastTouched(b, progressMap[b.id]) - lastTouched(a, progressMap[a.id]) ||
      String(a.title).localeCompare(String(b.title))
  )
}
