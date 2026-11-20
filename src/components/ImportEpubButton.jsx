import { useRef } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import { useImport } from '../contexts/importContext'

// Lets the user add books they already have, as .epub or .pdf files.
// Several can be picked at once. The work, and what it reports, is done by the
// app-wide importer (src/contexts/ImportProvider.jsx), which is also what handles
// files dropped on the window and files shared to the app. A scanned PDF that was
// stopped part way is listed here so it can be resumed.
export default function ImportEpubButton() {
  const { busy, jobs, importFiles, resume, discard } = useImport()
  const inputRef = useRef(null)

  function handleFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // so picking the same file again still fires onChange
    importFiles(files)
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

      {!busy && jobs.map((job) => (
        <div key={job.id} className="text-xs text-ink-muted text-right max-w-xs">
          <p className="mb-1">
            Unfinished: {job.fileName} ({job.pagesDone} of {job.pageCount} pages)
          </p>
          <button onClick={() => resume(job)} className="text-teal-600 font-medium mr-3">Resume</button>
          <button onClick={() => discard(job)} className="text-ink-muted hover:text-ink">Discard</button>
        </div>
      ))}
    </div>
  )
}
