import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import * as localdb from '../lib/db'
import * as cloud from '../lib/cloudFiles'

const LibraryContext = createContext(null)

// Books whose file is over the storage size limit. Remembered on this device
// so they are not tried again on every start.
const tooLargeKey = (userId) => `folio-cloud-toolarge:${userId}`
function readTooLarge(userId) {
  try { return new Set(JSON.parse(localStorage.getItem(tooLargeKey(userId)) || '[]')) } catch { return new Set() }
}
function markTooLarge(userId, bookId) {
  const set = readTooLarge(userId)
  set.add(bookId)
  localStorage.setItem(tooLargeKey(userId), JSON.stringify([...set]))
}

// Copies an imported book's file from this device to the user's account.
// Returns 'ok', 'too_large', or 'missing' (no file on this device). Throws if
// the network or server failed, so the caller can queue a retry.
async function pushBookFile(userId, bookId) {
  const blob = await localdb.getBookFile(bookId)
  if (!blob) return 'missing'
  const status = await cloud.uploadBookFile(userId, bookId, blob)
  if (status === 'too_large') markTooLarge(userId, bookId)
  return status
}

export function LibraryProvider({ children }) {
  const { user, isAuthenticated } = useAuth()
  const [collection, setCollection] = useState([]) // array of book meta objects
  const [progressMap, setProgressMap] = useState({}) // bookId -> progress object
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  // for imported books: 'synced' (a copy is in the account), 'too_large', or absent if not known yet
  const [cloudFiles, setCloudFiles] = useState({})
  const initialized = useRef(false)
  const collectionRef = useRef([])
  const progressRef = useRef({})
  const lastSyncRef = useRef(0)

  useEffect(() => { collectionRef.current = collection }, [collection])
  useEffect(() => { progressRef.current = progressMap }, [progressMap])

  // Brings the account's stored files in line with this device: finds which
  // imported books already have a copy, and uploads the ones this device has
  // a file for but the account does not (including books imported before
  // this feature existed). Needs no database column, the stored files are
  // listed instead.
  async function syncCloudFiles() {
    try {
      const inAccount = await cloud.listBookFiles(user.id)
      const tooLarge = readTooLarge(user.id)
      const status = {}
      const books = (await localdb.getAllBooksMeta()).filter((b) => b.source === 'import')
      for (const b of books) {
        if (inAccount.has(b.id)) { status[b.id] = 'synced'; continue }
        if (tooLarge.has(b.id)) { status[b.id] = 'too_large'; continue }
        try {
          const result = await pushBookFile(user.id, b.id)
          if (result !== 'missing') status[b.id] = result === 'ok' ? 'synced' : result
        } catch (err) {
          console.error('Could not copy a book to the account, will retry', b.id, err)
        }
      }
      // remote copies of books this device only knows from the library
      for (const id of inAccount) status[id] = 'synced'
      setCloudFiles((prev) => ({ ...prev, ...status }))
    } catch (err) {
      console.error('File sync failed', err)
    }
  }

  // Track connectivity
  useEffect(() => {
    function goOnline() { setIsOnline(true) }
    function goOffline() { setIsOnline(false) }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // Load local data immediately (fast, works offline), then reconcile with remote
  useEffect(() => {
    let cancelled = false

    async function init() {
      const localBooks = await localdb.getAllBooksMeta()
      const localProgress = await localdb.getAllProgressLocal()
      if (cancelled) return

      setCollection(localBooks)
      const pMap = {}
      localProgress.forEach((p) => { pMap[p.bookId] = p })
      setProgressMap(pMap)

      if (isAuthenticated && isOnline) {
        lastSyncRef.current = Date.now()
        await reconcileWithRemote(localBooks, pMap)
        await syncCloudFiles()
      }
      initialized.current = true
    }

    init()
    return () => { cancelled = true }
  }, [isAuthenticated, user?.id])

  // Whenever we come back online and are authenticated, flush queued changes
  useEffect(() => {
    if (isOnline && isAuthenticated && initialized.current) {
      flushPendingSync().then(syncCloudFiles)
    }
  }, [isOnline, isAuthenticated])

  // Sync only happening once, on initial load, means an already-open
  // tab never notices changes made on another device. This re-checks
  // with Supabase whenever the tab becomes visible again (switching
  // back to it, or unlocking the phone), with a short cooldown so
  // rapid tab-switching doesn't spam requests.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return
      if (!isAuthenticated || !isOnline || !initialized.current) return
      const now = Date.now()
      if (now - lastSyncRef.current < 15000) return
      lastSyncRef.current = now
      reconcileWithRemote(collectionRef.current, progressRef.current)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleVisibility)
    }
  }, [isAuthenticated, isOnline])

  async function reconcileWithRemote(localBooks, localProgressMap) {
    setSyncing(true)
    try {
      const { data: remoteBooks } = await supabase
        .from('collection_items')
        .select('*')
        .eq('user_id', user.id)

      const { data: remoteProgress } = await supabase
        .from('reading_progress')
        .select('*')
        .eq('user_id', user.id)

// Merge books: union of local + remote, remote wins on conflict
      // for metadata. A book that exists locally but is no longer in
      // the remote results has been removed on another device, so it
      // gets cleaned up here too, unless it's a local addition that
      // hasn't synced up yet (protected via the pending-sync queue).
      const remoteBookIds = new Set((remoteBooks || []).map((rb) => rb.book_id))
      const pending = await localdb.getPendingSync()
      const pendingAddIds = new Set(
        pending.filter((p) => p.type === 'add_book').map((p) => p.book.id)
      )

      const merged = { ...Object.fromEntries(localBooks.map((b) => [b.id, b])) }
      for (const localId of Object.keys(merged)) {
        if (!remoteBookIds.has(localId) && !pendingAddIds.has(localId)) {
          delete merged[localId]
          localdb.deleteBookMeta(localId).catch(() => {})
          localdb.deleteBookFile(localId).catch(() => {})
        }
      }
      for (const rb of remoteBooks || []) {
        merged[rb.book_id] = {
          id: rb.book_id,
          title: rb.title,
          author: rb.author,
          cover: rb.cover,
          source: rb.source,
          sourceId: rb.source_id,
          epubUrl: rb.epub_url,
          textUrl: rb.text_url,
          addedAt: rb.created_at,
        }
        await localdb.saveBookMeta(merged[rb.book_id])
      }
      setCollection(Object.values(merged))
      
      // Merge progress: last-write-wins by updatedAt
      const mergedProgress = { ...localProgressMap }
      for (const rp of remoteProgress || []) {
        const local = mergedProgress[rp.book_id]
        const remoteTime = new Date(rp.updated_at).getTime()
        const localTime = local?.updatedAt || 0
        if (!local || remoteTime > localTime) {
          mergedProgress[rp.book_id] = {
            bookId: rp.book_id,
            location: rp.location,
            percentage: rp.percentage,
            updatedAt: remoteTime,
          }
          await localdb.saveProgressLocal(rp.book_id, mergedProgress[rp.book_id])
        }
      }
      setProgressMap(mergedProgress)
    } catch (err) {
      console.error('Sync reconcile failed', err)
    } finally {
      setSyncing(false)
    }
  }

  async function flushPendingSync() {
    const pending = await localdb.getPendingSync()
    for (const entry of pending) {
      try {
        if (entry.type === 'progress') {
          await supabase.from('reading_progress').upsert({
            user_id: user.id,
            book_id: entry.bookId,
            location: entry.location,
            percentage: entry.percentage,
            updated_at: new Date(entry.updatedAt).toISOString(),
          }, { onConflict: 'user_id,book_id' })
        } else if (entry.type === 'add_book') {
          await supabase.from('collection_items').upsert({
            user_id: user.id,
            book_id: entry.book.id,
            title: entry.book.title,
            author: entry.book.author,
            cover: entry.book.cover,
            source: entry.book.source,
            source_id: entry.book.sourceId,
            epub_url: entry.book.epubUrl,
            text_url: entry.book.textUrl,
          }, { onConflict: 'user_id,book_id' })
        } else if (entry.type === 'remove_book') {
          await supabase.from('collection_items')
            .delete()
            .eq('user_id', user.id)
            .eq('book_id', entry.bookId)
          if (entry.bookId.startsWith('import-')) await cloud.removeBookFile(user.id, entry.bookId).catch(() => {})
        } else if (entry.type === 'upload_file') {
          const status = await pushBookFile(user.id, entry.bookId)
          if (status !== 'missing') setCloudFiles((prev) => ({ ...prev, [entry.bookId]: status === 'ok' ? 'synced' : status }))
        }
        await localdb.clearPendingSync(entry.id)
      } catch (err) {
        console.error('Failed to flush sync entry', entry, err)
        // leave it queued, try again next time
      }
    }
  }

  const addToCollection = useCallback(async (book) => {
    await localdb.saveBookMeta(book)
    setCollection((prev) => {
      if (prev.some((b) => b.id === book.id)) return prev
      return [...prev, book]
    })

    let recorded = false
    if (isAuthenticated && isOnline) {
      try {
        await supabase.from('collection_items').upsert({
          user_id: user.id,
          book_id: book.id,
          title: book.title,
          author: book.author,
          cover: book.cover,
          source: book.source,
          source_id: book.sourceId,
          epub_url: book.epubUrl,
          text_url: book.textUrl,
        }, { onConflict: 'user_id,book_id' })
        recorded = true
      } catch (err) {
        console.error('Remote add failed, queuing', err)
      }
    }
    if (!recorded) await localdb.queuePendingSync({ type: 'add_book', book })

    // An imported book's file only exists on this device, so copy it to the
    // account too, so the book can be opened on the user's other devices.
    if (book.source === 'import') {
      let uploaded = false
      if (isAuthenticated && isOnline) {
        try {
          const status = await pushBookFile(user.id, book.id)
          setCloudFiles((prev) => ({ ...prev, [book.id]: status === 'ok' ? 'synced' : status }))
          uploaded = true
        } catch (err) {
          console.error('File upload failed, queuing', err)
        }
      }
      if (!uploaded) await localdb.queuePendingSync({ type: 'upload_file', bookId: book.id })
    }
  }, [isAuthenticated, isOnline, user?.id])

  const removeFromCollection = useCallback(async (bookId) => {
    await localdb.deleteBookMeta(bookId)
    await localdb.deleteBookFile(bookId)
    setCollection((prev) => prev.filter((b) => b.id !== bookId))
    setCloudFiles((prev) => { const next = { ...prev }; delete next[bookId]; return next })

    if (isAuthenticated && isOnline) {
      try {
        await supabase.from('collection_items')
          .delete()
          .eq('user_id', user.id)
          .eq('book_id', bookId)
        if (bookId.startsWith('import-')) cloud.removeBookFile(user.id, bookId).catch(() => {})
        return
      } catch (err) {
        console.error('Remote remove failed, queuing', err)
      }
    }
    await localdb.queuePendingSync({ type: 'remove_book', bookId })
  }, [isAuthenticated, isOnline, user?.id])

  const saveProgress = useCallback(async (bookId, { location, percentage }) => {
    const updatedAt = Date.now()
    const progress = { bookId, location, percentage, updatedAt }
    await localdb.saveProgressLocal(bookId, progress)
    setProgressMap((prev) => ({ ...prev, [bookId]: progress }))

    if (isAuthenticated && isOnline) {
      try {
        await supabase.from('reading_progress').upsert({
          user_id: user.id,
          book_id: bookId,
          location,
          percentage,
          updated_at: new Date(updatedAt).toISOString(),
        }, { onConflict: 'user_id,book_id' })
        return
      } catch (err) {
        console.error('Remote progress save failed, queuing', err)
      }
    }
    await localdb.queuePendingSync({ type: 'progress', bookId, location, percentage, updatedAt })
  }, [isAuthenticated, isOnline, user?.id])

  const getProgress = useCallback((bookId) => progressMap[bookId] || null, [progressMap])

  const isInCollection = useCallback(
    (bookId) => collection.some((b) => b.id === bookId),
    [collection]
  )

  const value = {
    collection,
    progressMap,
    isOnline,
    syncing,
    cloudFiles,
    addToCollection,
    removeFromCollection,
    saveProgress,
    getProgress,
    isInCollection,
  }

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

export function useLibrary() {
  const ctx = useContext(LibraryContext)
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider')
  return ctx
}
