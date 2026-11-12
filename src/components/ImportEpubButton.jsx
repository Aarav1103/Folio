import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import { useLibrary } from '../contexts/LibraryContext'
import { importEpubFile, ImportError } from '../lib/importEpub'
import { listUnfinishedPdfJobs, discardPdfJob } from '../lib/importPdf'
import PdfImportDialog from './PdfImportDialog'

// Lets the user add books they already have, as .epub or .pdf files.
// Several can be picked at once, each is handled on its own so one bad
// file does not stop the rest. A PDF opens a dialog (see PdfImportDialog),
// and a scanned PDF that was stopped part way can be resumed from here.
export default function ImportEpubButton() {
  const { addToCollection } = useLibrary()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(0)
  const [failures, setFailures] = useState([])
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState(null) // { file, language } while a PDF is open
  const [jobs, setJobs] = useState([])
  const finishRef = useRef(null)

  const refreshJobs = useCallback(() => {
    listUnfinishedPdfJobs().then(setJobs).catch(() => setJobs([]))
  }, [])
  useEffect(() => { refreshJobs() }, [refreshJobs])

  // Shows the dialog for one PDF and waits until it reports back.
  function importPdf(file, language) {
    return new Promise((resolve) => {
      finishRef.current = resolve
      setDialog({ file, language })
    })
  }
  function handleDialogFinish(result) {
    setDialog(null)
    if (finishRef.current) finishRef.current(result)
    finishRef.current = null
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // so picking the same file again still fires onChange
    if (files.length === 0) return

    setBusy(true)
    setAdded(0)
    setFailures([])
    setNotice('')
    let ok = 0
    const failed = []
    for (const file of files) {
      try {
        let book = null
        if (/\.pdf$/i.test(file.name)) {
          const result = await importPdf(file)
          if (result.error) { failed.push(`${file.name}: ${result.error}`); continue }
          if (result.cancelled) { setNotice(`Stopped ${file.name}.`); continue }
          book = result.book
        } else {
          book = await importEpubFile(file)
        }
        await addToCollection(book)
        ok++
      } catch (err) {
        console.error('Import failed', file.name, err)
        const reason = err instanceof ImportError ? err.message : 'Could not read this file.'
        failed.push(`${file.name}: ${reason}`)
      }
    }
    setAdded(ok)
    setFailures(failed)
    setBusy(false)
    refreshJobs()
  }

  async function resume(job) {
    setBusy(true)
    setAdded(0)
    setFailures([])
    setNotice('')
    try {
      const file = new File([job.blob], job.fileName, { type: 'application/pdf' })
      const result = await importPdf(file, job.language)
      if (result.book) { await addToCollection(result.book); setAdded(1) }
      else if (result.error) setFailures([`${job.fileName}: ${result.error}`])
      else if (result.cancelled) setNotice(`Stopped ${job.fileName}.`)
    } catch (err) {
      console.error('Resume failed', err)
      setFailures([`${job.fileName}: Could not read this file.`])
    }
    setBusy(false)
    refreshJobs()
  }

  async function discard(job) {
    await discardPdfJob(job.id)
    refreshJobs()
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        multiple
        onChange={handleFiles}
        className="hidden"
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-2 border border-ink/15 text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink/5 transition-colors disabled:opacity-60"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
        {busy ? 'Importing...' : 'Import book'}
      </button>
      {added > 0 && (
        <p className="text-xs text-teal-600">
          Added {added} {added === 1 ? 'book' : 'books'} to your library.
        </p>
      )}
      {notice && <p className="text-xs text-ink-muted text-right max-w-xs">{notice}</p>}
      {failures.map((line) => (
        <p key={line} className="text-xs text-red-600 text-right max-w-xs">{line}</p>
      ))}

      {!busy && jobs.map((job) => (
        <div key={job.id} className="text-xs text-ink-muted text-right max-w-xs">
          <p className="mb-1">
            Unfinished: {job.fileName} ({job.pagesDone} of {job.pageCount} pages)
          </p>
          <button onClick={() => resume(job)} className="text-teal-600 font-medium mr-3">Resume</button>
          <button onClick={() => discard(job)} className="text-ink-muted hover:text-ink">Discard</button>
        </div>
      ))}

      {dialog && <PdfImportDialog file={dialog.file} language={dialog.language} onFinish={handleDialogFinish} />}
    </div>
  )
}
