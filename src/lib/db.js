import { openDB } from 'idb'

// Local IndexedDB store. This is what makes offline reading possible.
// It holds the actual book files (epub/text) plus a local mirror of
// progress and collection data so the app works with no network at all.

const DB_NAME = 'folio-db'
const DB_VERSION = 3

let dbPromise = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('pendingSync')) {
          db.createObjectStore('pendingSync', { keyPath: 'id', autoIncrement: true })
        }
        // version 2: scanned PDFs being converted (see the PDF jobs section)
        if (!db.objectStoreNames.contains('pdfJobs')) {
          db.createObjectStore('pdfJobs', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('ocrPages')) {
          db.createObjectStore('ocrPages', { keyPath: ['jobId', 'page'] })
        }
        // version 3: library folders, and which folder each book is in
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('placements')) {
          db.createObjectStore('placements', { keyPath: 'bookId' })
        }
      },
    })
  }
  return dbPromise
}

// --- Books metadata (title, author, cover url, source id) ---
export async function saveBookMeta(book) {
  const db = await getDB()
  return db.put('books', book)
}

export async function getBookMeta(id) {
  const db = await getDB()
  return db.get('books', id)
}

export async function getAllBooksMeta() {
  const db = await getDB()
  return db.getAll('books')
}

export async function deleteBookMeta(id) {
  const db = await getDB()
  return db.delete('books', id)
}

// --- Book file content (for offline reading) ---
export async function saveBookFile(bookId, blob) {
  const db = await getDB()
  return db.put('files', { bookId, blob, savedAt: Date.now() })
}

export async function getBookFile(bookId) {
  const db = await getDB()
  const record = await db.get('files', bookId)
  return record ? record.blob : null
}

export async function hasOfflineFile(bookId) {
  const db = await getDB()
  const record = await db.get('files', bookId)
  return !!record
}

export async function deleteBookFile(bookId) {
  const db = await getDB()
  return db.delete('files', bookId)
}

// --- Reading progress (local-first, synced to Supabase when online) ---
// The progress keeps the time it was saved with. A position that came from the
// account must keep the time it was saved there (not "now", which would make it
// look newer than later saves made on a device whose clock is behind this one).
// Only a progress with no time of its own is stamped with the current time.
export async function saveProgressLocal(bookId, progress) {
  const db = await getDB()
  const updatedAt = Number.isFinite(progress.updatedAt) ? progress.updatedAt : Date.now()
  return db.put('progress', { bookId, ...progress, updatedAt })
}

export async function getProgressLocal(bookId) {
  const db = await getDB()
  return db.get('progress', bookId)
}

export async function getAllProgressLocal() {
  const db = await getDB()
  return db.getAll('progress')
}

// --- Library folders (local-first, synced to Supabase when online) ---
// A folder is { id, name, position, deleted, updatedAt, dirty } and a placement (which
// folder a book is in) is { bookId, folderId, updatedAt, dirty }. `dirty` means "changed
// here and not yet sent to the account"; see src/contexts/FolderProvider.jsx.
export async function getAllFolders() {
  const db = await getDB()
  return db.getAll('folders')
}

export async function putFolders(folders) {
  const db = await getDB()
  const tx = db.transaction('folders', 'readwrite')
  for (const folder of folders) tx.store.put(folder)
  return tx.done
}

export async function getAllPlacements() {
  const db = await getDB()
  return db.getAll('placements')
}

export async function putPlacements(placements) {
  const db = await getDB()
  const tx = db.transaction('placements', 'readwrite')
  for (const placement of placements) tx.store.put(placement)
  return tx.done
}

// --- Pending sync queue, for changes made while offline ---
export async function queuePendingSync(entry) {
  const db = await getDB()
  return db.add('pendingSync', entry)
}

// Progress is queued at most once per book: only the newest position matters, so
// it replaces an older queued one (while offline there would otherwise be one
// entry for every pause in scrolling).
export async function queueProgressSync(entry) {
  const db = await getDB()
  const tx = db.transaction('pendingSync', 'readwrite')
  const store = tx.objectStore('pendingSync')
  for (const queued of await store.getAll()) {
    if (queued.type === 'progress' && queued.bookId === entry.bookId) await store.delete(queued.id)
  }
  await store.add(entry)
  await tx.done
}

// A position was sent successfully, so queued positions of that book that are
// not newer are out of date and must not be sent later over it.
export async function dropPendingProgress(bookId, upToTime) {
  const db = await getDB()
  const tx = db.transaction('pendingSync', 'readwrite')
  const store = tx.objectStore('pendingSync')
  for (const queued of await store.getAll()) {
    if (queued.type === 'progress' && queued.bookId === bookId && (queued.updatedAt || 0) <= upToTime) {
      await store.delete(queued.id)
    }
  }
  await tx.done
}

export async function getPendingSync() {
  const db = await getDB()
  return db.getAll('pendingSync')
}

export async function clearPendingSync(id) {
  const db = await getDB()
  return db.delete('pendingSync', id)
}

// --- PDF jobs: a scanned PDF being converted, so it can be resumed ---
// Recognising text is slow, so each finished page is saved as it completes.
// If the tab is closed or the phone sleeps part way through, the job (with
// the PDF itself) is still here and conversion carries on from where it
// stopped. A job is removed once the book has been made.

export async function savePdfJob(job) {
  const db = await getDB()
  return db.put('pdfJobs', job)
}

export async function getPdfJob(id) {
  const db = await getDB()
  return db.get('pdfJobs', id)
}

export async function listPdfJobs() {
  const db = await getDB()
  return db.getAll('pdfJobs')
}

export async function saveOcrPage(record) {
  const db = await getDB()
  return db.put('ocrPages', record)
}

export async function getOcrPage(jobId, page) {
  const db = await getDB()
  return db.get('ocrPages', [jobId, page])
}

export async function countOcrPages(jobId) {
  const db = await getDB()
  return db.count('ocrPages', IDBKeyRange.bound([jobId, 0], [jobId, Infinity]))
}

export async function deletePdfJob(id) {
  const db = await getDB()
  const tx = db.transaction(['pdfJobs', 'ocrPages'], 'readwrite')
  tx.objectStore('pdfJobs').delete(id)
  tx.objectStore('ocrPages').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))
  return tx.done
}
