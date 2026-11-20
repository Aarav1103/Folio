// Library folders: the rules for naming, ordering, combining changes from two devices,
// and laying the library out. Nothing here touches the browser, so it can be tested alone.
//
// A folder:     { id, name, position, deleted, updatedAt, dirty }
// A placement:  { bookId, folderId, updatedAt, dirty }   (folderId null = not in a folder)
// `updatedAt` is when it was last changed (a number); `dirty` means "changed on this device
// and not yet sent to the account".
//
// Folders hold books only, one level deep, and a book is in at most one folder. Folders go in
// the order the person arranges them (`position`); books go by recency, as everywhere else.

import { sortByRecency } from './recency.js'

export const MAX_FOLDER_NAME = 60

// A folder name as typed, made tidy: spaces squeezed, trimmed, cut to a sensible length.
// Returns '' if nothing is left, which means "not a usable name".
export function cleanFolderName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME).trim()
}

// Folders that have not been deleted, in the person's order. Folders at the same place
// (two devices made one at the same moment) go by name, then id, so every device agrees.
export function liveFolders(folderMap) {
  return Object.values(folderMap || {})
    .filter((f) => !f.deleted)
    .sort((a, b) => a.position - b.position || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))
}

// The position for a new folder: after all the others.
export function positionAfterLast(folderMap) {
  const live = liveFolders(folderMap)
  return live.length ? live[live.length - 1].position + 1 : 1
}

// The position for a folder moved between two neighbours (either may be missing, meaning the
// start or the end). Positions are fractions, so moving one folder never changes the others.
export function positionBetween(before, after) {
  if (before == null && after == null) return 1
  if (before == null) return after - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

// Positions have only so much precision: after very many moves into the same gap two
// neighbours become too close to tell apart. Then every folder is given a fresh whole position.
export function needsRenumbering(folderMap) {
  const live = liveFolders(folderMap)
  for (let i = 1; i < live.length; i++) if (live[i].position - live[i - 1].position < 1e-9) return true
  return false
}

// The newest change wins. A change from the account replaces ours only if it is newer
// (a tie keeps ours), and it keeps the time it was made with, never "now": clocks differ
// between devices, and re-stamping it would make it look newer than later changes.
function mergeByTime(local, rows, keyOf, toRecord) {
  const merged = { ...local }
  const taken = []
  for (const row of rows || []) {
    const time = Date.parse(row.updated_at)
    if (Number.isNaN(time)) continue
    const key = keyOf(row)
    const mine = merged[key]
    if (mine && !(time > (mine.updatedAt || 0))) continue
    merged[key] = toRecord(row, time)
    taken.push(merged[key])
  }
  return { merged, taken }
}

// local: { folderId: folder }; rows: [{ id, name, position, deleted, updated_at }]
export function mergeRemoteFolders(local, rows) {
  return mergeByTime(local, rows, (r) => r.id, (r, time) => ({
    id: r.id,
    name: String(r.name ?? ''),
    position: Number.isFinite(Number(r.position)) ? Number(r.position) : 0,
    deleted: !!r.deleted,
    updatedAt: time,
    dirty: false,
  }))
}

// local: { bookId: placement }; rows: [{ book_id, folder_id, updated_at }]
export function mergeRemotePlacements(local, rows) {
  return mergeByTime(local, rows, (r) => r.book_id, (r, time) => ({
    bookId: r.book_id,
    folderId: r.folder_id ?? null,
    updatedAt: time,
    dirty: false,
  }))
}

// The library as it is shown: the folders in order, each with its books (most recent first),
// then the books that are in no folder (most recent first). A placement that names a folder
// that is gone (deleted, or not arrived yet) counts as "in no folder".
export function buildLayout(books, folderMap, placements, progressMap = {}) {
  const folders = liveFolders(folderMap).map((f) => ({ ...f, books: [] }))
  const byId = new Map(folders.map((f) => [f.id, f]))
  const loose = []
  for (const book of books || []) {
    const placement = placements && placements[book.id]
    const folder = placement && placement.folderId ? byId.get(placement.folderId) : null
    if (folder) folder.books.push(book)
    else loose.push(book)
  }
  for (const folder of folders) folder.books = sortByRecency(folder.books, progressMap)
  return { folders, loose: sortByRecency(loose, progressMap) }
}

// The folder a book is in, or null
export function folderOfBook(bookId, folderMap, placements) {
  const placement = placements && placements[bookId]
  if (!placement || !placement.folderId) return null
  const folder = folderMap && folderMap[placement.folderId]
  return folder && !folder.deleted ? folder : null
}
