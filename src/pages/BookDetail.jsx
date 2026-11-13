import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLibrary } from '../contexts/LibraryContext'
import { useAuth } from '../contexts/AuthContext'
import { downloadBookFile } from '../lib/cloudFiles'
import { getBookById } from '../lib/gutendex'
import { hasOfflineFile, saveBookFile } from '../lib/db'
import { fetchBookContent } from '../lib/gutendex'
import { getBookById as getArchiveBookById, resolveArchiveEpubUrl } from '../lib/archive'
import { getBookById as getGoogleBookById } from '../lib/googlebooks'
import { ArrowLeft, Plus, Check, Download, BookOpen, Loader2 } from 'lucide-react'

// Shown when Google would not hand over a free book's epub.
const GOOGLE_REFUSED = "Google wouldn't let Folio download this book. Some of Google's free books can only be read on Google's own site."

export default function BookDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { collection, addToCollection, removeFromCollection, isInCollection, getProgress, cloudFiles, isOnline } = useLibrary()
  const { user } = useAuth()

  const [book, setBook] = useState(null)
  const [loading, setLoading] = useState(true)
  const [offlineReady, setOfflineReady] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // Set when an Internet Archive item turns out to have no epub file.
  // Search results aren't pre-checked for this any more (that made
  // search slow), so it's discovered here, as soon as the page opens.
  const [noEpubFor, setNoEpubFor] = useState(null) // book id
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      // First check if it's already in the local collection (works offline)
      const existing = collection.find((b) => b.id === id)
      if (existing) {
        if (!cancelled) setBook(existing)
      } else if (id.startsWith('gutenberg-')) {
        try {
          const sourceId = id.replace('gutenberg-', '')
          const fetched = await getBookById(sourceId)
          if (!cancelled) setBook(fetched)
        } catch (err) {
          console.error(err)
        }
      } else if (id.startsWith('archive-')) {
        try {
          const sourceId = id.replace('archive-', '')
          const fetched = await getArchiveBookById(sourceId)
          if (!cancelled) setBook(fetched)
        } catch (err) {
          console.error(err)
        }
      } else if (id.startsWith('google-')) {
        try {
          const fetched = await getGoogleBookById(id.replace('google-', ''))
          if (!cancelled) setBook(fetched)
        } catch (err) {
          console.error(err)
        }
      }
      const offline = await hasOfflineFile(id)
      if (!cancelled) {
        setOfflineReady(offline)
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [id, collection])

  // Looks up the epub for an Internet Archive book that hasn't had one
  // resolved yet (a no-op for every other book). Throws if the item has
  // no epub, so callers can stop before adding it to the library.
  async function ensureEpub(b) {
    if (b.source !== 'archive' || (b.epubUrl && b.epubUrl.startsWith('http'))) return b
    const epubUrl = await resolveArchiveEpubUrl(b.sourceId)
    if (!epubUrl) {
      setNoEpubFor(b.id)
      throw new Error('No epub format available for this book')
    }
    const resolved = { ...b, epubUrl, needsEpubResolution: false }
    setBook(resolved)
    return resolved
  }

  // Quietly checks in the background, so a book with no epub is flagged
  // before the user presses anything. Failures here are ignored, the
  // buttons re-check on click.
  useEffect(() => {
    if (!book || book.source !== 'archive' || (book.epubUrl && book.epubUrl.startsWith('http'))) return
    let cancelled = false
    resolveArchiveEpubUrl(book.sourceId)
      .then((url) => {
        if (cancelled) return
        if (url) setBook((prev) => (prev ? { ...prev, epubUrl: url, needsEpubResolution: false } : prev))
        else setNoEpubFor(book.id)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [book])

  // Google's download links are not guaranteed to work from here (some need a
  // sign-in and answer with a web page instead of the epub). So a Google
  // book's file is fetched and checked first. If it is not a real epub, an
  // epub is a zip file and starts with "PK", the book is not added to the
  // library and the user is told, rather than ending up with a book that
  // will not open.
  async function downloadGoogleBook(b) {
    if (await hasOfflineFile(b.id)) { setOfflineReady(true); return }
    setDownloading(true)
    try {
      const { blob } = await fetchBookContent(b)
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('not an epub')
      await saveBookFile(b.id, blob)
      setOfflineReady(true)
    } catch (err) {
      console.error('Google download failed', err)
      throw new Error('GOOGLE_DOWNLOAD_FAILED', { cause: err })
    } finally {
      setDownloading(false)
    }
  }

  async function handleToggleCollection() {
    if (isInCollection(book.id)) {
      await removeFromCollection(book.id)
    } else {
      await addToCollection({ ...book, addedAt: Date.now() })
    }
  }

  async function handleStartReading() {
    setActionError('')
    try {
      const bookToOpen = await ensureEpub(book)
      if (bookToOpen.source === 'google') await downloadGoogleBook(bookToOpen)
      if (!isInCollection(bookToOpen.id)) {
        await addToCollection({ ...bookToOpen, addedAt: Date.now() })
      }
      navigate(`/read/${bookToOpen.id}`)
    } catch (err) {
      console.error(err)
      setActionError(
        err.message === 'No epub format available for this book'
          ? "This book has no epub file, so it can't be read in Folio."
          : err.message === 'GOOGLE_DOWNLOAD_FAILED'
            ? GOOGLE_REFUSED
            : 'Could not open this book. Check your connection and try again.'
      )
    }
  }

  async function handleDownloadOffline() {
    setDownloading(true)
    setActionError('')
    try {
      if (book.source === 'import') {
        // an imported book's file comes from the user's account
        const remote = await downloadBookFile(user.id, book.id)
        if (!remote) throw new Error('NOT_IN_ACCOUNT')
        await saveBookFile(book.id, remote)
        setOfflineReady(true)
        return
      }
      if (book.source === 'google') {
        await downloadGoogleBook(book)
        if (!isInCollection(book.id)) await addToCollection({ ...book, addedAt: Date.now() })
        return
      }
      const bookToFetch = await ensureEpub(book)
      const { blob } = await fetchBookContent(bookToFetch)
      await saveBookFile(bookToFetch.id, blob)
      setOfflineReady(true)
      if (!isInCollection(bookToFetch.id)) {
        await addToCollection({ ...bookToFetch, addedAt: Date.now() })
      }
    } catch (err) {
      console.error(err)
      setActionError(
        err.message === 'No epub format available for this book'
          ? "This book has no epub file, so it can't be downloaded."
          : err.message === 'GOOGLE_DOWNLOAD_FAILED'
            ? GOOGLE_REFUSED
          : err.message === 'NOT_IN_ACCOUNT'
            ? "This book isn't in your account yet. Open Folio on the device you imported it on, while online, or import the file here."
            : 'Could not download this book for offline reading.'
      )
    } finally {
      setDownloading(false)
    }
  }
  const progress = book ? getProgress(book.id) : null

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-ink-muted gap-2">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading...</span>
      </div>
    )
  }

  if (!book) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-ink-muted text-sm mb-4">This book isn't available, especially if you're offline.</p>
        <button onClick={() => navigate(-1)} className="text-teal-600 text-sm font-medium">
          Go back
        </button>
      </div>
    )
  }

  const inCollection = isInCollection(book.id)
  const noEpub = noEpubFor === book.id
  // Imported books live only as a file on the device they were imported
  // on, there's nothing remote to download.
  const isImported = book.source === 'import'
  // where an imported book's file is: on this device, and/or copied to the account
  const cloudStatus = cloudFiles[book.id]
  const importedStatus =
    cloudStatus === 'synced' && offlineReady ? 'Saved to your account, so you can open it on your other devices.'
    : cloudStatus === 'synced' ? 'Saved in your account. It downloads to this device when you open it.'
    : cloudStatus === 'too_large' ? 'This file is too large to copy to your account (the limit is 50 MB), so it is only on this device.'
    : offlineReady ? (isOnline ? 'Copying to your account...' : 'Will be copied to your account when you are back online.')
    : 'Not on this device yet. It downloads from your account when you open it.'

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-ink-muted text-sm mb-6 hover:text-ink">
        <ArrowLeft size={16} /> Back
      </button>

      <div className="flex flex-col sm:flex-row gap-8">
        <div className="w-40 flex-shrink-0 mx-auto sm:mx-0">
          <div className="rounded-sm overflow-hidden shadow-lg">
            {book.cover ? (
              <img src={book.cover} alt={book.title} className="w-full aspect-[2/3] object-cover" />
            ) : (
              <div className="w-full aspect-[2/3] flex items-center justify-center bg-gradient-to-br from-teal-100 to-parchment p-4">
                <span className="font-display text-sm text-teal-600 text-center">{book.title}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 text-center sm:text-left">
          <h1 className="font-display text-2xl sm:text-3xl text-ink leading-tight">{book.title}</h1>
          <p className="text-ink-muted mt-1.5">{book.author}</p>

          {book.subjects?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4 justify-center sm:justify-start">
              {book.subjects.slice(0, 4).map((s) => (
                <span key={s} className="text-xs bg-ink/5 text-ink-muted px-2.5 py-1 rounded-full">
                  {s.split(' -- ')[0]}
                </span>
              ))}
            </div>
          )}

          {progress && progress.percentage > 0 && (
            <div className="mt-5 max-w-xs mx-auto sm:mx-0">
              <div className="flex justify-between text-xs text-ink-muted mb-1">
                <span>Progress</span>
                <span>{Math.round(progress.percentage)}%</span>
              </div>
              <div className="h-1.5 bg-ink/10 rounded-full overflow-hidden">
                <div className="h-full bg-teal-500" style={{ width: `${progress.percentage}%` }} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 mt-6 justify-center sm:justify-start">
            <button
              onClick={handleStartReading}
              disabled={noEpub || downloading}
              className="flex items-center gap-2 bg-teal-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-teal-500 transition-colors disabled:opacity-50"
            >
              <BookOpen size={16} />
              {progress?.percentage > 0 ? 'Continue reading' : 'Start reading'}
            </button>
            <button
              onClick={handleToggleCollection}
              className="flex items-center gap-2 border border-ink/15 text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-ink/5 transition-colors"
            >
              {inCollection ? <Check size={16} className="text-teal-600" /> : <Plus size={16} />}
              {inCollection ? 'In your library' : 'Add to library'}
            </button>

            <button
              onClick={handleDownloadOffline}
              disabled={downloading || offlineReady || noEpub}
              className="flex items-center gap-2 border border-ink/15 text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-ink/5 transition-colors disabled:opacity-60"
            >
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {offlineReady ? 'Available offline' : downloading ? 'Downloading...' : isImported ? 'Download to this device' : 'Download for offline'}
            </button>
          </div>

          {isImported && <p className="text-xs text-ink-muted mt-3">{importedStatus}</p>}

          {(noEpub || actionError) && (
            <p className="text-sm text-red-600 mt-4">
              {actionError || "This book has no epub file, so it can't be read in Folio."}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
