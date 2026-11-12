import { openDB } from 'idb'

// Local IndexedDB store. This is what makes offline reading possible.
// It holds the actual book files (epub/text) plus a local mirror of
// progress and collection data so the app works with no network at all.

const DB_NAME = 'folio-db'
const DB_VERSION = 2

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
export async function saveProgressLocal(bookId, progress) {
  const db = await getDB()
  return db.put('progress', { bookId, ...progress, updatedAt: Date.now() })
}

export async function getProgressLocal(bookId) {
  const db = await getDB()
  return db.get('progress', bookId)
}

export async function getAllProgressLocal() {
  const db = await getDB()
  return db.getAll('progress')
}

// --- Pending sync queue, for changes made while offline ---
export async function queuePendingSync(entry) {
  const db = await getDB()
  return db.add('pendingSync', entry)
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
