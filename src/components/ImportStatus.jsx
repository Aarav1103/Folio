import { useEffect } from 'react'
import { Loader2, X } from 'lucide-react'
import { useImport } from '../contexts/importContext'

// What the importer is doing and what it did, in one place whichever page is open:
// "Importing ..." while it works, then how many books were added and anything that failed.
// Success goes away by itself; a failure stays until it is dismissed.
export default function ImportStatus() {
  const { busy, current, status, dismissStatus, hasDialog } = useImport()
  const hasProblems = !!status && (status.failures.length > 0 || !!status.notice)

  useEffect(() => {
    if (!status || hasProblems) return undefined
    const timer = setTimeout(dismissStatus, 8000)
    return () => clearTimeout(timer)
  }, [status, hasProblems, dismissStatus])

  if (hasDialog) return null // the PDF dialog shows progress itself
  if (!busy && !status) return null
  if (!busy && status.added === 0 && !hasProblems) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-3 right-3 bottom-20 md:bottom-4 md:left-4 md:right-auto md:w-80 z-50 rounded-xl bg-parchment border border-ink/15 px-4 py-3 shadow-lg text-sm"
    >
      {busy ? (
        <p className="flex items-center gap-2 text-ink">
          <Loader2 size={15} className="animate-spin flex-shrink-0" />
          <span className="truncate">Importing {current || 'books'}...</span>
        </p>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 space-y-1">
            {status.added > 0 && (
              <p className="text-teal-600">
                Added {status.added} {status.added === 1 ? 'book' : 'books'} to your library.
              </p>
            )}
            {status.notice && <p className="text-ink-muted">{status.notice}</p>}
            {status.failures.map((line) => (
              <p key={line} className="text-red-600 break-words">{line}</p>
            ))}
          </div>
          <button onClick={dismissStatus} aria-label="Dismiss" className="p-1 -m-1 text-ink-muted hover:text-ink flex-shrink-0">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
