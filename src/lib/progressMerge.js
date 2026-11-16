// Rules for combining reading progress, so devices agree on where you are.
//
// Each saved position carries the time it was saved. When this device holds one
// and the account holds another for the same book, the later one wins. A tie
// keeps this device's copy.
//
// Clocks differ between devices (a few minutes is normal), so a time on its own
// cannot be trusted to order saves made on different devices. Two rules deal with
// that: a position taken from the account keeps the time it was saved with (it is
// never re-stamped with this device's clock), and a new save is always stamped
// later than the position it replaces, even if this device's clock says
// otherwise. That way the device you pick up next sees your latest save as the
// latest, whatever the two clocks say.

// Folds rows read from the account into the progress held on this device.
// local: { bookId: { bookId, location, percentage, updatedAt } }
// rows: [{ book_id, location, percentage, updated_at }]
// Returns the combined map, and the positions that were taken from the account.
export function mergeRemoteProgress(local, rows) {
  const merged = { ...local }
  const taken = []
  for (const row of rows || []) {
    const remoteTime = Date.parse(row.updated_at)
    if (Number.isNaN(remoteTime)) continue
    const mine = merged[row.book_id]
    if (mine && !(remoteTime > (mine.updatedAt || 0))) continue
    const progress = {
      bookId: row.book_id,
      location: row.location,
      percentage: row.percentage,
      updatedAt: remoteTime,
    }
    merged[row.book_id] = progress
    taken.push(progress)
  }
  return { merged, taken }
}

// The time to stamp a new save with: now, but never earlier than (or equal to)
// the position it replaces.
export function nextSaveTime(previous, now = Date.now()) {
  const last = previous && Number.isFinite(previous.updatedAt) ? previous.updatedAt : 0
  return Math.max(now, last + 1)
}
