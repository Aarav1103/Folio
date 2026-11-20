import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import * as localdb from '../lib/db'
import * as cloud from '../lib/cloudFiles'
import { mergeRemoteProgress, nextSaveTime } from '../lib/progressMerge'

const LibraryContext = createContext(null)

// How often an open app that is in view asks the account for progress made on
// other devices (a return to the app asks straight away, see below).
const POLL_MS = 20000
// Coming back to the app (or the window getting focus) refreshes progress, but not
// more often than this, so switching windows quickly does not send a request each time.
const FOREGROUND_COOLDOWN_MS = 2000
// The same return also refreshes the whole library (the list of books), less often.
const FULL_REFRESH_COOLDOWN_MS = 15000
// A request to the account that has not answered by now is given up on.
const REQUEST_TIMEOUT_MS = 20000
// A book added on this device counts as "just added" for this long: longer than a request to
// the account may take, with some margin. See the refresh of the book list (reconcileWithRemote).
const RECENT_ADD_MS = REQUEST_TIMEOUT_MS + 25000

// (Older browsers have no AbortSignal.timeout: the request then simply has no time limit.)
const requestSignal = () =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined

// Runs fn unless it is already running, in which case the run in progress is
// returned. A run that takes longer than maxMs stops blocking others (a stuck
// request on a bad connection must not stop every later sync).
function singleFlight(ref, fn, maxMs = 30000) {
  if (ref.current) return ref.current
  let timer
  const run = Promise.race([
    fn(),
    new Promise((resolve) => { timer = setTimeout(resolve, maxMs) }),
  ]).finally(() => {
    clearTimeout(timer)
    if (ref.current === run) ref.current = null
  })
  ref.current = run
  return run
}

// The account's answer to a write is an {error} value, not a thrown error, so a
// failed request has to be checked for explicitly or it looks like it worked.
function raise(result) {
  if (result && result.error) throw result.error
  return result
}

const progressRow = (userId, p) => ({
  user_id: userId,
  book_id: p.bookId,
  location: p.location,
  percentage: p.percentage,
  updated_at: new Date(p.updatedAt).toISOString(),
})

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
  const initialized = useRef(false) // this device's own data has been loaded
  const [ready, setReady] = useState(false) // the same, as state: code that adds books waits for it
  const collectionRef = useRef([])
  // Books added on this device a moment ago: bookId -> { book, at }. The account's list of books,
  // if it was asked for before the account was told about the book, does not have it yet, and a
  // book missing from that list is taken to have been removed on another device. Without this a
  // book added (or imported, or shared to the app) just as the app opened vanished from the
  // library when the list arrived, and if the account had not been told yet, its stored file
  // was deleted as well.
  const recentAddsRef = useRef({})
  const progressRef = useRef({})
  const lastFullRefreshRef = useRef(0)

  // The latest sign-in and connection state, for code that runs later (timers,
  // listeners, requests in flight) and must not use values from an older render.
  const userIdRef = useRef(null)
  const signedInRef = useRef(false)
  const onlineRef = useRef(navigator.onLine)
  useEffect(() => { userIdRef.current = user?.id ?? null; signedInRef.current = !!(isAuthenticated && user) }, [user?.id, isAuthenticated])
  useEffect(() => { onlineRef.current = isOnline }, [isOnline])
  const canSync = () => signedInRef.current && onlineRef.current && !!userIdRef.current

  useEffect(() => { collectionRef.current = collection }, [collection])
  useEffect(() => { progressRef.current = progressMap }, [progressMap])

  const flushFlight = useRef(null)
  const pullFlight = useRef(null)
  const reconcileFlight = useRef(null)
  const cloudSyncing = useRef(false)
  const sendState = useRef(new Map()) // bookId -> { sending, next }

  // Brings the account's stored files in line with this device: finds which
  // imported books already have a copy, and uploads the ones this device has
  // a file for but the account does not (including books imported before
  // this feature existed). Needs no database column, the stored files are
  // listed instead. Uploads can be slow, so nothing waits for this to finish.
  const syncCloudFiles = useCallback(async () => {
    if (cloudSyncing.current || !canSync()) return
    cloudSyncing.current = true
    const userId = userIdRef.current
    try {
      const inAccount = await cloud.listBookFiles(userId)
      const tooLarge = readTooLarge(userId)
      const status = {}
      const books = (await localdb.getAllBooksMeta()).filter((b) => b.source === 'import')
      for (const b of books) {
        if (inAccount.has(b.id)) { status[b.id] = 'synced'; continue }
        if (tooLarge.has(b.id)) { status[b.id] = 'too_large'; continue }
        try {
          const result = await pushBookFile(userId, b.id)
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
    } finally {
      cloudSyncing.current = false
    }
  }, [])

  // Sends the changes made while offline (or while a request failed). An entry
  // is only removed once the account has really accepted it.
  const flushPendingSync = useCallback(() => singleFlight(flushFlight, async () => {
    if (!canSync()) return
    const userId = userIdRef.current
    const pending = await localdb.getPendingSync()
    for (const entry of pending) {
      try {
        if (entry.type === 'progress') {
          raise(await supabase.from('reading_progress').upsert(progressRow(userId, entry), { onConflict: 'user_id,book_id' }).abortSignal(requestSignal()))
        } else if (entry.type === 'add_book') {
          raise(await supabase.from('collection_items').upsert({
            user_id: userId,
            book_id: entry.book.id,
            title: entry.book.title,
            author: entry.book.author,
            cover: entry.book.cover,
            source: entry.book.source,
            source_id: entry.book.sourceId,
            epub_url: entry.book.epubUrl,
            text_url: entry.book.textUrl,
          }, { onConflict: 'user_id,book_id' }))
        } else if (entry.type === 'remove_book') {
          raise(await supabase.from('collection_items')
            .delete()
            .eq('user_id', userId)
            .eq('book_id', entry.bookId))
          if (entry.bookId.startsWith('import-')) await cloud.removeBookFile(userId, entry.bookId).catch(() => {})
        } else if (entry.type === 'upload_file') {
          const status = await pushBookFile(userId, entry.bookId)
          if (status !== 'missing') setCloudFiles((prev) => ({ ...prev, [entry.bookId]: status === 'ok' ? 'synced' : status }))
        }
        await localdb.clearPendingSync(entry.id)
      } catch (err) {
        console.error('Failed to flush sync entry', entry, err)
        // leave it queued, try again next time
      }
    }
  }), [])

  // Asks the account for the reading progress made on other devices and folds it
  // in. This is small and does not touch the list of books or any file, so it can
  // run often and is never held up by them.
  const pullProgress = useCallback(() => singleFlight(pullFlight, async () => {
    if (!canSync()) return false
    try {
      const { data, error } = await supabase
        .from('reading_progress')
        .select('book_id,location,percentage,updated_at')
        .eq('user_id', userIdRef.current)
        .abortSignal(requestSignal())
      if (error) throw error
      const { taken } = mergeRemoteProgress(progressRef.current, data)
      if (taken.length) {
        for (const p of taken) {
          progressRef.current = { ...progressRef.current, [p.bookId]: p }
          await localdb.saveProgressLocal(p.bookId, p)
        }
        // merged again against the newest state, in case something was saved meanwhile
        setProgressMap((prev) => mergeRemoteProgress(prev, data).merged)
      }
      return true
    } catch (err) {
      console.error('Progress refresh failed', err)
      return false
    }
  }), [])

  // The newest known position of one book: asks the account, and returns whichever
  // of its answer and this device's own copy is later. Never throws; if the
  // account cannot be reached it returns this device's copy.
  const refreshBookProgress = useCallback(async (bookId) => {
    const mine = progressRef.current[bookId] || (await localdb.getProgressLocal(bookId)) || null
    if (!canSync()) return mine
    try {
      const { data, error } = await supabase
        .from('reading_progress')
        .select('book_id,location,percentage,updated_at')
        .eq('user_id', userIdRef.current)
        .eq('book_id', bookId)
        .abortSignal(requestSignal())
        .maybeSingle()
      if (error || !data) return mine
      const { taken } = mergeRemoteProgress(mine ? { [bookId]: mine } : {}, [data])
      if (!taken.length) return mine
      const p = taken[0]
      progressRef.current = { ...progressRef.current, [bookId]: p }
      await localdb.saveProgressLocal(bookId, p)
      setProgressMap((prev) => mergeRemoteProgress(prev, [data]).merged)
      return p
    } catch {
      return mine
    }
  }, [])

  // The full refresh: the list of books and all progress.
  const reconcileWithRemote = useCallback((localBooks) => singleFlight(reconcileFlight, async () => {
    if (!canSync()) return
    const userId = userIdRef.current
    const books = localBooks || collectionRef.current
    setSyncing(true)
    try {
      const [booksResult, progressResult] = await Promise.all([
        supabase.from('collection_items').select('*').eq('user_id', userId).abortSignal(requestSignal()),
        supabase.from('reading_progress').select('book_id,location,percentage,updated_at').eq('user_id', userId).abortSignal(requestSignal()),
      ])
      raise(booksResult)
      raise(progressResult)
      const remoteBooks = booksResult.data
      const remoteProgress = progressResult.data

      // Progress first: it is what people are waiting for, and the book list
      // below writes every book to local storage one at a time.
      const { taken } = mergeRemoteProgress(progressRef.current, remoteProgress)
      for (const p of taken) {
        progressRef.current = { ...progressRef.current, [p.bookId]: p }
        await localdb.saveProgressLocal(p.bookId, p)
      }
      if (taken.length) setProgressMap((prev) => mergeRemoteProgress(prev, remoteProgress).merged)

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

      // books added here a moment ago (forgetting those long past)
      const recentAdds = () => {
        const now = Date.now()
        const recent = {}
        for (const [id, entry] of Object.entries(recentAddsRef.current)) {
          if (now - entry.at < RECENT_ADD_MS) recent[id] = entry.book
          else delete recentAddsRef.current[id]
        }
        return recent
      }
      const justAdded = recentAdds()

      const merged = { ...Object.fromEntries(books.map((b) => [b.id, b])) }
      for (const localId of Object.keys(merged)) {
        if (!remoteBookIds.has(localId) && !pendingAddIds.has(localId) && !justAdded[localId]) {
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
      // Books added here while this refresh was under way (or whose add has not reached the
      // account yet) are not in the list the account sent: they stay.
      for (const [id, book] of Object.entries(recentAdds())) {
        if (!merged[id]) merged[id] = book
      }
      setCollection(Object.values(merged))
    } catch (err) {
      console.error('Sync reconcile failed', err)
    } finally {
      setSyncing(false)
    }
  }), [])

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
      collectionRef.current = localBooks
      const pMap = {}
      localProgress.forEach((p) => { pMap[p.bookId] = p })
      setProgressMap(pMap)
      progressRef.current = pMap
      initialized.current = true
      setReady(true)

      if (isAuthenticated && isOnline) {
        lastFullRefreshRef.current = Date.now()
        // Changes queued in an earlier session go out now, in the background
        flushPendingSync()
        await reconcileWithRemote(localBooks)
        // Copying imported books to the account can take minutes on a slow
        // connection, so it runs on its own and nothing waits for it.
        if (!cancelled) syncCloudFiles()
      }
    }

    init()
    return () => { cancelled = true }
  }, [isAuthenticated, user?.id])

  // Keeps this device up to date with the account while the app is open:
  //  - progress is refreshed every POLL_MS while the app is in view,
  //  - and straight away when the app comes back into view or the window gets
  //    focus (switching back from another device or app, unlocking the phone),
  //  - queued changes are sent at the same moments, and when the connection returns.
  // None of this waits for the start-up sync, which can be slow.
  useEffect(() => {
    if (!isAuthenticated || !isOnline) return undefined
    let lastTick = 0

    async function tick() {
      lastTick = Date.now()
      await flushPendingSync()
      await pullProgress()
    }

    function onForeground() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastTick >= FOREGROUND_COOLDOWN_MS) tick()
      if (initialized.current && now - lastFullRefreshRef.current >= FULL_REFRESH_COOLDOWN_MS) {
        lastFullRefreshRef.current = now
        reconcileWithRemote()
      }
    }

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') tick()
    }, POLL_MS)
    document.addEventListener('visibilitychange', onForeground)
    window.addEventListener('focus', onForeground)

    // The connection came back, or the user signed in: catch up now
    if (initialized.current) {
      tick().then(syncCloudFiles)
    }

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onForeground)
      window.removeEventListener('focus', onForeground)
    }
  }, [isAuthenticated, isOnline, user?.id])

  const addToCollection = useCallback(async (book) => {
    recentAddsRef.current[book.id] = { book, at: Date.now() }
    await localdb.saveBookMeta(book)
    setCollection((prev) => {
      if (prev.some((b) => b.id === book.id)) return prev
      return [...prev, book]
    })

    let recorded = false
    if (isAuthenticated && isOnline) {
      try {
        raise(await supabase.from('collection_items').upsert({
          user_id: user.id,
          book_id: book.id,
          title: book.title,
          author: book.author,
          cover: book.cover,
          source: book.source,
          source_id: book.sourceId,
          epub_url: book.epubUrl,
          text_url: book.textUrl,
        }, { onConflict: 'user_id,book_id' }))
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
    delete recentAddsRef.current[bookId]
    await localdb.deleteBookMeta(bookId)
    await localdb.deleteBookFile(bookId)
    setCollection((prev) => prev.filter((b) => b.id !== bookId))
    setCloudFiles((prev) => { const next = { ...prev }; delete next[bookId]; return next })

    if (isAuthenticated && isOnline) {
      try {
        raise(await supabase.from('collection_items')
          .delete()
          .eq('user_id', user.id)
          .eq('book_id', bookId))
        if (bookId.startsWith('import-')) cloud.removeBookFile(user.id, bookId).catch(() => {})
        return
      } catch (err) {
        console.error('Remote remove failed, queuing', err)
      }
    }
    await localdb.queuePendingSync({ type: 'remove_book', bookId })
  }, [isAuthenticated, isOnline, user?.id])

  // Sends a book's latest position to the account. If a send is already under
  // way for the book, only the newest position is kept for after it, so saves
  // always arrive in order and a burst of them costs one request. A position
  // that could not be sent is queued (one per book) and retried later.
  const sendProgress = useCallback(async (progress) => {
    let state = sendState.current.get(progress.bookId)
    if (!state) { state = { sending: false, next: null }; sendState.current.set(progress.bookId, state) }
    state.next = progress
    if (state.sending) return
    state.sending = true
    try {
      while (state.next) {
        const p = state.next
        state.next = null
        let sent = false
        if (canSync()) {
          try {
            raise(await supabase.from('reading_progress').upsert(progressRow(userIdRef.current, p), { onConflict: 'user_id,book_id' }).abortSignal(requestSignal()))
            sent = true
          } catch (err) {
            console.error('Remote progress save failed, queuing', err)
          }
        }
        if (sent) await localdb.dropPendingProgress(p.bookId, p.updatedAt)
        else await localdb.queueProgressSync({ type: 'progress', bookId: p.bookId, location: p.location, percentage: p.percentage, updatedAt: p.updatedAt })
      }
    } finally {
      state.sending = false
    }
  }, [])

  const saveProgress = useCallback(async (bookId, { location, percentage }) => {
    // stamped later than the position it replaces, whatever this device's clock says
    const updatedAt = nextSaveTime(progressRef.current[bookId])
    const progress = { bookId, location, percentage, updatedAt }
    progressRef.current = { ...progressRef.current, [bookId]: progress }
    await localdb.saveProgressLocal(bookId, progress)
    setProgressMap((prev) => ({ ...prev, [bookId]: progress }))
    await sendProgress(progress)
  }, [sendProgress])

  const getProgress = useCallback((bookId) => progressMap[bookId] || null, [progressMap])

  // The newest position known on this device right now, including one just taken from the
  // account. Unlike getProgress it is never a render behind, and it does not change identity.
  const getKnownProgress = useCallback((bookId) => progressRef.current[bookId] || null, [])

  const isInCollection = useCallback(
    (bookId) => collection.some((b) => b.id === bookId),
    [collection]
  )

  const value = {
    ready,
    collection,
    progressMap,
    isOnline,
    syncing,
    cloudFiles,
    addToCollection,
    removeFromCollection,
    saveProgress,
    getProgress,
    getKnownProgress,
    refreshBookProgress,
    isInCollection,
  }

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

export function useLibrary() {
  const ctx = useContext(LibraryContext)
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider')
  return ctx
}
