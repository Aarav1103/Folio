import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { useLibrary } from './LibraryContext'
import { ImportContext } from './importContext'
import { importEpubFile, ImportError } from '../lib/importEpub'
import { listUnfinishedPdfJobs, discardPdfJob } from '../lib/importPdf'
import { bookFileKind, withBookExtension } from '../lib/fileKinds'
import { takeSharedFiles } from '../lib/sharedFiles'
import PdfImportDialog from '../components/PdfImportDialog'
import ImportStatus from '../components/ImportStatus'
import DropZone from '../components/DropZone'

// Adds books from .epub and .pdf files, from wherever they come: the Import button, files
// dropped on the window, and files shared to the installed app from another app on a phone.
// They all go through importFiles, so they behave the same: files are handled one after
// another, each on its own so one bad file does not stop the rest; a PDF opens a dialog (see
// PdfImportDialog); files that arrive while an import is running join the queue.
//
// What happened is shown in one place (ImportStatus), whichever page is open.
export default function ImportProvider({ children }) {
  const { addToCollection, ready } = useLibrary()
  const { isAuthenticated, loading } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState('') // the file being imported now
  const [status, setStatus] = useState(null) // { added, failures, notice } once a run is done
  const [dialog, setDialog] = useState(null) // { file, language } while a PDF is open
  const [jobs, setJobs] = useState([]) // scanned PDFs that were stopped part way

  const queueRef = useRef([])
  const runningRef = useRef(false)
  const finishRef = useRef(null)
  const addRef = useRef(addToCollection)
  useEffect(() => { addRef.current = addToCollection }, [addToCollection])

  const refreshJobs = useCallback(() => {
    listUnfinishedPdfJobs().then(setJobs).catch(() => setJobs([]))
  }, [])
  useEffect(() => { refreshJobs() }, [refreshJobs])

  // Shows the dialog for one PDF and waits until it reports back.
  const importPdf = useCallback((file, language) => new Promise((resolve) => {
    finishRef.current = resolve
    setDialog({ file, language })
  }), [])
  const handleDialogFinish = useCallback((result) => {
    setDialog(null)
    if (finishRef.current) finishRef.current(result)
    finishRef.current = null
  }, [])

  const importFiles = useCallback(async (list) => {
    const files = Array.from(list || []).filter(Boolean)
    if (files.length === 0) return
    queueRef.current.push(...files)
    if (runningRef.current) return // the run in progress picks these up
    runningRef.current = true
    setBusy(true)
    setStatus(null)
    let added = 0
    const failures = []
    let notice = ''
    while (queueRef.current.length > 0) {
      const original = queueRef.current.shift()
      setCurrent(original.name)
      try {
        const kind = bookFileKind(original)
        if (!kind) { failures.push(`${original.name}: Only .epub and .pdf files can be added.`); continue }
        const file = withBookExtension(original, kind)
        let book = null
        if (kind === 'pdf') {
          const result = await importPdf(file)
          if (result.error) { failures.push(`${original.name}: ${result.error}`); continue }
          if (result.cancelled) { notice = `Stopped ${original.name}.`; continue }
          book = result.book
        } else {
          book = await importEpubFile(file)
        }
        await addRef.current(book)
        added++
      } catch (err) {
        console.error('Import failed', original.name, err)
        failures.push(`${original.name}: ${err instanceof ImportError ? err.message : 'Could not read this file.'}`)
      }
    }
    setCurrent('')
    setStatus({ added, failures, notice })
    runningRef.current = false
    setBusy(false)
    refreshJobs()
  }, [importPdf, refreshJobs])

  const resume = useCallback(async (job) => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    setStatus(null)
    setCurrent(job.fileName)
    let next = { added: 0, failures: [], notice: '' }
    try {
      const file = new File([job.blob], job.fileName, { type: 'application/pdf' })
      const result = await importPdf(file, job.language)
      if (result.book) { await addRef.current(result.book); next = { ...next, added: 1 } }
      else if (result.error) next = { ...next, failures: [`${job.fileName}: ${result.error}`] }
      else if (result.cancelled) next = { ...next, notice: `Stopped ${job.fileName}.` }
    } catch (err) {
      console.error('Resume failed', err)
      next = { ...next, failures: [`${job.fileName}: Could not read this file.`] }
    }
    setCurrent('')
    setStatus(next)
    runningRef.current = false
    setBusy(false)
    refreshJobs()
  }, [importPdf, refreshJobs])

  const discard = useCallback(async (job) => {
    await discardPdfJob(job.id)
    refreshJobs()
  }, [refreshJobs])

  const dismissStatus = useCallback(() => setStatus(null), [])
  const reportFailure = useCallback((message) => setStatus({ added: 0, failures: [message], notice: '' }), [])

  // Files shared to the app from another app arrive in a cache (public/share-target-sw.js).
  // They are imported once the person is signed in and the library has loaded (a book added
  // before then could be lost when the library loads), at start-up and whenever the app
  // comes back into view. A share that could not be received is reported.
  useEffect(() => {
    if (loading || !isAuthenticated || !ready) return undefined
    async function takeShared() {
      const files = await takeSharedFiles()
      const marker = new URLSearchParams(window.location.search).get('shared')
      if (files.length > 0) {
        navigate('/collection', { replace: true })
        importFiles(files)
      } else if (marker !== null) {
        navigate(window.location.pathname, { replace: true }) // drop "?shared=..." from the address
        if (marker === 'error') reportFailure('The shared file could not be received. Use Import book instead.')
      }
    }
    takeShared()
    const onShown = () => { if (document.visibilityState === 'visible') takeShared() }
    document.addEventListener('visibilitychange', onShown)
    return () => document.removeEventListener('visibilitychange', onShown)
  }, [loading, isAuthenticated, ready, navigate, importFiles, reportFailure])

  const value = { busy, current, status, jobs, importFiles, resume, discard, dismissStatus, hasDialog: !!dialog }
  // files dropped on the window do nothing while reading: that page is for reading, and a PDF dialog over a book would be odd
  const dropAllowed = isAuthenticated && !pathname.startsWith('/read/')

  return (
    <ImportContext.Provider value={value}>
      {children}
      <DropZone allowed={dropAllowed} signedIn={isAuthenticated} onFiles={importFiles} onRefused={reportFailure} />
      <ImportStatus />
      {dialog && <PdfImportDialog file={dialog.file} language={dialog.language} onFinish={handleDialogFinish} />}
    </ImportContext.Provider>
  )
}
