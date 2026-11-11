import { useRef, useState } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import { useLibrary } from '../contexts/LibraryContext'
import { importEpubFile, ImportError } from '../lib/importEpub'

// Lets the user add .epub files they already have. Several can be picked
// at once, each is handled on its own so one bad file doesn't stop the rest.
export default function ImportEpubButton() {
  const { addToCollection } = useLibrary()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(0)
  const [failures, setFailures] = useState([])

  async function handleFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // so picking the same file again still fires onChange
    if (files.length === 0) return

    setBusy(true)
    setAdded(0)
    setFailures([])
    let ok = 0
    const failed = []
    for (const file of files) {
      try {
        const book = await importEpubFile(file)
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
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".epub,application/epub+zip"
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
        {busy ? 'Importing...' : 'Import EPUB'}
      </button>
      {added > 0 && (
        <p className="text-xs text-teal-600">
          Added {added} {added === 1 ? 'book' : 'books'} to your library.
        </p>
      )}
      {failures.map((line) => (
        <p key={line} className="text-xs text-red-600 text-right max-w-xs">{line}</p>
      ))}
    </div>
  )
}
