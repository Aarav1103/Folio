import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { useLibrary } from './LibraryContext'
import { FoldersContext } from './foldersContext'
import * as localdb from '../lib/db'
import { nextSaveTime } from '../lib/progressMerge'
import { cleanFolderName, positionAfterLast, planReorder, mergeRemoteFolders, mergeRemotePlacements } from '../lib/folders'

// The library's folders, and which folder each book is in (rules in src/lib/folders.js).
//
// Local first, like everything else: a change is applied and saved on this device at once,
// marked `dirty`, and sent to the account when it can be. Every row carries the time it was
// last changed and the newest change wins, so devices that were offline agree once they meet.
// A row is only marked clean after the account has accepted it, so nothing is lost if the
// connection drops half way or the tables are not set up yet (supabase-folders.sql): the
// folders then still work on this device, and are sent once the tables exist.

const POLL_MS = 30000 // how often a visible app asks the account for changes made elsewhere
const FOREGROUND_COOLDOWN_MS = 2000 // coming back to the app asks straight away, but not more often than this
const REQUEST_TIMEOUT_MS = 20000

const requestSignal = () =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined

// The Supabase client returns a failed request as an {error} value instead of throwing it
function raise(result) {
  if (result && result.error) throw result.error
  return result
}

const newId = () =>
  globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const folderRow = (userId, f) => ({ user_id: userId, id: f.id, name: f.name, position: f.position, deleted: !!f.deleted, updated_at: new Date(f.updatedAt).toISOString() })
const placementRow = (userId, p) => ({ user_id: userId, book_id: p.bookId, folder_id: p.folderId, updated_at: new Date(p.updatedAt).toISOString() })

export default function FolderProvider({ children }) {
  const { isOnline } = useLibrary()
  const { user, isAuthenticated } = useAuth()
  const [folders, setFolders] = useState({}) // folder id -> folder
  const [placements, setPlacements] = useState({}) // book id -> placement
  const [loaded, setLoaded] = useState(false) // this device's own folders have been read

  // the latest values, for code that runs later (timers, requests in flight)
  const foldersRef = useRef({})
  const placementsRef = useRef({})
  const userIdRef = useRef(null)
  const signedInRef = useRef(false)
  const onlineRef = useRef(true)
  const warnedRef = useRef(false)
  const pushState = useRef({ running: false, again: false })
  const pulling = useRef(false)
  useEffect(() => { userIdRef.current = user?.id ?? null }, [user?.id])
  useEffect(() => { signedInRef.current = !!isAuthenticated }, [isAuthenticated])
  useEffect(() => { onlineRef.current = !!isOnline }, [isOnline])
  const canSync = () => signedInRef.current && onlineRef.current && !!userIdRef.current

  useEffect(() => {
    let cancelled = false
    Promise.all([localdb.getAllFolders(), localdb.getAllPlacements()])
      .then(([fs, ps]) => {
        if (cancelled) return
        const folderMap = Object.fromEntries(fs.map((f) => [f.id, f]))
        const placementMap = Object.fromEntries(ps.map((p) => [p.bookId, p]))
        foldersRef.current = folderMap
        placementsRef.current = placementMap
        setFolders(folderMap)
        setPlacements(placementMap)
        setLoaded(true)
      })
      .catch((err) => {
        console.error('Could not read folders on this device', err)
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  // Failing to reach the account, or the tables not existing yet, is not shown as an error
  // (the folders still work here); it is logged, the first time only.
  const warn = useCallback((err) => {
    if (warnedRef.current) return
    warnedRef.current = true
    console.error('Folder sync failed (folders still work on this device)', err)
  }, [])

  // Applies changed rows to this device: memory first (so the screen is right at once, and a
  // second change made straight away builds on this one), then storage.
  const store = useCallback(async (changedFolders, changedPlacements) => {
    if (changedFolders.length) {
      const next = { ...foldersRef.current }
      for (const f of changedFolders) next[f.id] = f
      foldersRef.current = next
      setFolders(next)
    }
    if (changedPlacements.length) {
      const next = { ...placementsRef.current }
      for (const p of changedPlacements) next[p.bookId] = p
      placementsRef.current = next
      setPlacements(next)
    }
    try {
      await Promise.all([localdb.putFolders(changedFolders), localdb.putPlacements(changedPlacements)])
    } catch (err) {
      console.error('Could not save folders on this device', err)
    }
  }, [])

  // Sends every changed row to the account. A change made while a send is under way is
  // picked up by another round straight after.
  const push = useCallback(async () => {
    const state = pushState.current
    if (state.running) { state.again = true; return }
    state.running = true
    try {
      do {
        state.again = false
        if (!canSync()) break
        const userId = userIdRef.current
        const dirtyFolders = Object.values(foldersRef.current).filter((f) => f.dirty)
        const dirtyPlacements = Object.values(placementsRef.current).filter((p) => p.dirty)
        if (dirtyFolders.length === 0 && dirtyPlacements.length === 0) break
        try {
          if (dirtyFolders.length) {
            raise(await supabase.from('folders').upsert(dirtyFolders.map((f) => folderRow(userId, f)), { onConflict: 'user_id,id' }).abortSignal(requestSignal()))
          }
          if (dirtyPlacements.length) {
            raise(await supabase.from('book_folders').upsert(dirtyPlacements.map((p) => placementRow(userId, p)), { onConflict: 'user_id,book_id' }).abortSignal(requestSignal()))
          }
        } catch (err) {
          warn(err)
          break
        }
        warnedRef.current = false
        // clean only what was sent, and only if it has not been changed again since
        const cleanFolders = dirtyFolders
          .filter((sent) => foldersRef.current[sent.id] && foldersRef.current[sent.id].updatedAt === sent.updatedAt)
          .map((sent) => ({ ...foldersRef.current[sent.id], dirty: false }))
        const cleanPlacements = dirtyPlacements
          .filter((sent) => placementsRef.current[sent.bookId] && placementsRef.current[sent.bookId].updatedAt === sent.updatedAt)
          .map((sent) => ({ ...placementsRef.current[sent.bookId], dirty: false }))
        await store(cleanFolders, cleanPlacements)
      } while (state.again)
    } finally {
      state.running = false
    }
  }, [store, warn])

  // Takes in changes made on other devices
  const pull = useCallback(async () => {
    if (pulling.current || !canSync()) return
    pulling.current = true
    try {
      const userId = userIdRef.current
      const [folderResult, placementResult] = await Promise.all([
        supabase.from('folders').select('id,name,position,deleted,updated_at').eq('user_id', userId).abortSignal(requestSignal()),
        supabase.from('book_folders').select('book_id,folder_id,updated_at').eq('user_id', userId).abortSignal(requestSignal()),
      ])
      raise(folderResult)
      raise(placementResult)
      // both merges are worked out from the latest state, with nothing waited on in between
      const f = mergeRemoteFolders(foldersRef.current, folderResult.data)
      const p = mergeRemotePlacements(placementsRef.current, placementResult.data)
      if (f.taken.length || p.taken.length) await store(f.taken, p.taken)
      warnedRef.current = false
    } catch (err) {
      warn(err)
    } finally {
      pulling.current = false
    }
  }, [store, warn])

  // Keeps this device in step with the account while the app is open: now, every POLL_MS
  // while it is in view, when it comes back into view, and when the connection returns.
  useEffect(() => {
    if (!loaded || !isAuthenticated || !isOnline) return undefined
    let last = 0
    const run = async () => {
      last = Date.now()
      // Changes from other devices are taken in first, then ours are sent. This way a change
      // made here while offline, if another device has changed the same thing since (later),
      // gives way to it, instead of being sent over it.
      await pull()
      await push()
    }
    run()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') run() }, POLL_MS)
    const onShown = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= FOREGROUND_COOLDOWN_MS) run()
    }
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('focus', onShown)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('focus', onShown)
    }
  }, [loaded, isAuthenticated, isOnline, user?.id, push, pull])

  const commit = useCallback(async (changedFolders, changedPlacements) => {
    await store(changedFolders, changedPlacements)
    push()
  }, [store, push])

  // A new folder, at the end of the folders, optionally with books already in it.
  // Returns the folder, or null if the name was not usable.
  const createFolder = useCallback(async (name, bookIds = []) => {
    const clean = cleanFolderName(name)
    if (!clean) return null
    const now = Date.now()
    const folder = { id: newId(), name: clean, position: positionAfterLast(foldersRef.current), deleted: false, updatedAt: now, dirty: true }
    const placed = bookIds.map((bookId) => ({ bookId, folderId: folder.id, updatedAt: nextSaveTime(placementsRef.current[bookId], now), dirty: true }))
    await commit([folder], placed)
    return folder
  }, [commit])

  const renameFolder = useCallback(async (id, name) => {
    const clean = cleanFolderName(name)
    const folder = foldersRef.current[id]
    if (!clean || !folder || folder.deleted || folder.name === clean) return false
    await commit([{ ...folder, name: clean, updatedAt: nextSaveTime(folder), dirty: true }], [])
    return true
  }, [commit])

  // Its books go back to the top level of the library; no book is removed.
  const deleteFolder = useCallback(async (id) => {
    const folder = foldersRef.current[id]
    if (!folder || folder.deleted) return false
    const freed = Object.values(placementsRef.current)
      .filter((p) => p.folderId === id)
      .map((p) => ({ ...p, folderId: null, updatedAt: nextSaveTime(p), dirty: true }))
    await commit([{ ...folder, deleted: true, updatedAt: nextSaveTime(folder), dirty: true }], freed)
    return true
  }, [commit])

  // Puts books in a folder, or (folderId null) back at the top level of the library.
  const moveBooks = useCallback(async (bookIds, folderId) => {
    if (folderId !== null && !(foldersRef.current[folderId] && !foldersRef.current[folderId].deleted)) return 0
    const changed = []
    for (const bookId of new Set(bookIds)) {
      const current = placementsRef.current[bookId]
      if ((current ? current.folderId : null) === folderId) continue
      changed.push({ bookId, folderId, updatedAt: nextSaveTime(current), dirty: true })
    }
    if (changed.length) await commit([], changed)
    return changed.length
  }, [commit])

  // Puts a folder just before or after another (where: 'before' | 'after'). Usually only the
  // moved folder changes. Returns false if nothing changed.
  const reorderFolder = useCallback(async (id, targetId, where) => {
    const plan = planReorder(foldersRef.current, id, targetId, where)
    if (!plan) return false
    const changed = plan.map(({ id: folderId, position }) => {
      const folder = foldersRef.current[folderId]
      return { ...folder, position, updatedAt: nextSaveTime(folder), dirty: true }
    })
    await commit(changed, [])
    return true
  }, [commit])

  const value = useMemo(
    () => ({ folders, placements, loaded, createFolder, renameFolder, deleteFolder, moveBooks, reorderFolder }),
    [folders, placements, loaded, createFolder, renameFolder, deleteFolder, moveBooks, reorderFolder],
  )
  return <FoldersContext.Provider value={value}>{children}</FoldersContext.Provider>
}
