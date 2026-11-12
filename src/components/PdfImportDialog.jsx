import { useEffect, useRef, useState } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { preparePdfImport, OCR_LANGUAGES } from '../lib/importPdf'
import { ImportError } from '../lib/importEpub'

// Walks one PDF through: reading it, asking about text recognition if it is
// a scan, converting with progress and a cancel button, and reporting back.
//
// onFinish is called exactly once with one of:
//   { book }              the converted book, ready to add to the library
//   { cancelled: true }   the user stopped it (a scan keeps its progress)
//   { error: 'message' }  it could not be done

const LANGUAGE_KEY = 'folio-ocr-language'

async function runConversion({ session, language, signal, setPhase, setProgress, setErrorMessage, onFinish }) {
  setPhase('converting')
  setProgress(null)
  try {
    const book = await session.convert({ language, signal, onProgress: setProgress })
    onFinish({ book })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      onFinish({ cancelled: true })
    } else {
      console.error('PDF conversion failed', err)
      setErrorMessage(err instanceof ImportError ? err.message : 'This PDF could not be converted.')
      setPhase('error')
    }
  }
}

function describe(progress, phase) {
  if (phase === 'analyzing') {
    return progress && progress.total ? `Reading the PDF, page ${progress.page} of ${progress.total}` : 'Reading the PDF'
  }
  if (!progress) return 'Starting'
  if (progress.stage === 'ocr-setup') {
    return String(progress.status || '').includes('traineddata')
      ? 'Downloading language data for text recognition'
      : 'Getting text recognition ready'
  }
  if (progress.stage === 'building') return 'Building your book'
  const base = `Page ${progress.page} of ${progress.total}`
  return progress.ocrTotal ? `${base}, recognised ${progress.ocrDone} of ${progress.ocrTotal} scanned pages` : base
}

function fraction(progress) {
  if (!progress) return 0
  if (progress.stage === 'ocr-setup') return Math.min(1, progress.progress || 0)
  if (progress.stage === 'building') return 1
  return progress.total ? progress.page / progress.total : 0
}

export default function PdfImportDialog({ file, language: resumeLanguage, onFinish }) {
  const [phase, setPhase] = useState('analyzing') // analyzing | confirm | converting | error
  const [analysis, setAnalysis] = useState(null)
  const [progress, setProgress] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [language, setLanguage] = useState(() => resumeLanguage || localStorage.getItem(LANGUAGE_KEY) || 'eng')

  const sessionRef = useRef(null)
  const controllerRef = useRef(null)
  const finishedRef = useRef(false)
  // the latest finish handler, without making the effect below depend on it
  const onFinishRef = useRef(onFinish)
  useEffect(() => { onFinishRef.current = onFinish }, [onFinish])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    controllerRef.current = controller
    const finish = (result) => {
      if (finishedRef.current) return
      finishedRef.current = true
      onFinishRef.current(result)
    }

    ;(async () => {
      try {
        const session = await preparePdfImport(file, {
          signal: controller.signal,
          onProgress: (p) => { if (!cancelled) setProgress(p) },
        })
        if (cancelled) { session.destroy(); return }
        sessionRef.current = session
        setAnalysis(session.analysis)
        // a scan needs the user's say (and a language) first, unless resuming
        if (session.analysis.ocrNeeded && !resumeLanguage) {
          setPhase('confirm')
        } else {
          runConversion({
            session, language, signal: controller.signal,
            setPhase, setProgress, setErrorMessage, onFinish: finish,
          })
        }
      } catch (err) {
        if (cancelled) return
        if (err && err.name === 'AbortError') { finish({ cancelled: true }); return }
        console.error('Could not open PDF', err)
        setErrorMessage(err instanceof ImportError ? err.message : 'This PDF could not be read.')
        setPhase('error')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      if (sessionRef.current) sessionRef.current.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per file
  }, [file])

  // keep the screen awake while converting, a sleeping phone pauses the work
  useEffect(() => {
    if (phase !== 'converting' || !('wakeLock' in navigator)) return
    let lock = null
    let released = false
    const acquire = () => navigator.wakeLock.request('screen').then((l) => { if (released) l.release(); else lock = l }).catch(() => {})
    acquire()
    const again = () => { if (document.visibilityState === 'visible') acquire() }
    document.addEventListener('visibilitychange', again)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', again)
      if (lock) lock.release().catch(() => {})
    }
  }, [phase])

  function start() {
    localStorage.setItem(LANGUAGE_KEY, language)
    runConversion({
      session: sessionRef.current, language, signal: controllerRef.current.signal,
      setPhase, setProgress, setErrorMessage,
      onFinish: (r) => { if (!finishedRef.current) { finishedRef.current = true; onFinishRef.current(r) } },
    })
  }

  function cancel() {
    if (phase === 'converting') {
      controllerRef.current.abort() // runConversion reports the cancellation
    } else if (!finishedRef.current) {
      finishedRef.current = true
      onFinishRef.current({ cancelled: true })
    }
  }

  function closeError() {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinishRef.current({ error: errorMessage })
  }

  const scanPages = analysis ? analysis.lowTextPages.length : 0
  const minutes = Math.max(1, Math.round((scanPages * 2.5) / 60))
  const pct = Math.round(fraction(progress) * 100)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5" role="dialog" aria-modal="true" aria-labelledby="pdf-dialog-title">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl border border-ink/10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center flex-shrink-0">
            <FileText size={18} className="text-teal-600" strokeWidth={1.75} />
          </div>
          <h2 id="pdf-dialog-title" className="text-sm font-medium text-ink truncate">{file.name}</h2>
        </div>

        {(phase === 'analyzing' || phase === 'converting') && (
          <div>
            <div className="flex items-center gap-2 text-sm text-ink-muted mb-3">
              <Loader2 size={15} className="animate-spin flex-shrink-0" />
              <span>{describe(progress, phase)}</span>
            </div>
            {phase === 'converting' && (
              <div className="h-1.5 bg-ink/10 rounded-full overflow-hidden mb-4" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-teal-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            {phase === 'converting' && analysis && analysis.ocrNeeded && (
              <p className="text-xs text-ink-muted mb-4">
                Keep this window open. If you stop, the pages already read are saved and you can resume later.
              </p>
            )}
            <div className="flex justify-end">
              <button onClick={cancel} className="text-sm font-medium text-ink-muted px-4 py-2 rounded-lg hover:bg-ink/5">
                {phase === 'converting' ? 'Stop' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {phase === 'confirm' && analysis && (
          <div>
            <p className="text-sm font-medium text-ink mb-1">This PDF looks scanned</p>
            <p className="text-sm text-ink-muted mb-4">
              {scanPages} of {analysis.pageCount} pages are pictures of text. Folio will read them with text
              recognition on this device, nothing is uploaded. Expect a few seconds per page, so roughly {minutes}{' '}
              {minutes === 1 ? 'minute' : 'minutes'} here, and longer on a phone.
            </p>
            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5" htmlFor="ocr-language">
              Language of the book
            </label>
            <select
              id="ocr-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-ink/15 bg-white text-sm mb-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
            >
              {OCR_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <p className="text-xs text-ink-muted mb-5">The first time, the language data (a few MB) is downloaded and kept for next time.</p>
            <div className="flex justify-end gap-2">
              <button onClick={cancel} className="text-sm font-medium text-ink-muted px-4 py-2 rounded-lg hover:bg-ink/5">Cancel</button>
              <button onClick={start} className="bg-teal-600 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-teal-500 transition-colors">Start</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <p className="text-sm text-red-600 mb-5">{errorMessage}</p>
            <div className="flex justify-end">
              <button onClick={closeError} className="text-sm font-medium px-4 py-2 rounded-lg border border-ink/15 hover:bg-ink/5">Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
