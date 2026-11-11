import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { searchBooks, getPopularBooks, getBooksByTopic, CURATED_TOPICS } from '../lib/gutendex'
import * as archive from '../lib/archive'
import BookCard from '../components/BookCard'
import { Search, Loader2 } from 'lucide-react'

export default function Discover() {
  // The current search/topic lives in the URL (?q=... or ?topic=...),
  // not just component state, so refreshing, sharing a link, or using
  // the browser's back button actually returns to what you were
  // looking at instead of resetting to the default popular list.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlQuery = searchParams.get('q') || ''
  const urlTopic = searchParams.get('topic') || null

  const [query, setQuery] = useState(urlQuery)
  const [activeTopic, setActiveTopic] = useState(urlTopic)
  // Each source keeps its own results, so whichever answers first can be
  // shown right away without waiting for the other (Internet Archive is
  // much slower than Gutendex). Gutendex results are listed first.
  const [gutResults, setGutResults] = useState([])
  const [archResults, setArchResults] = useState([])
  const [gutHasMore, setGutHasMore] = useState(false)
  const [archHasMore, setArchHasMore] = useState(false)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const results = [...gutResults, ...archResults]
  const hasMore = gutHasMore || archHasMore

  // Remembers how to fetch the *current* search/topic/popular view at
  // an arbitrary page, so "Load more" can just ask for page + 1
  // without needing to know whether we're searching, browsing a topic,
  // or looking at the popular list.
  const fetcherRef = useRef(null)
  const pageRef = useRef(1)
  // Bumped on every fetch. A response that arrives after a newer search
  // has started is stale and gets dropped, instead of overwriting it.
  const requestIdRef = useRef(0)

  const runFetch = useCallback(async (makeFetchers, { append = false, skipGutendex = false, skipArchive = false } = {}) => {
    const requestId = ++requestIdRef.current
    const isCurrent = () => requestId === requestIdRef.current
    const targetPage = append ? pageRef.current + 1 : 1

    if (append) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setGutResults([])
      setArchResults([])
      setGutHasMore(false)
      setArchHasMore(false)
    }
    setError('')

    const { gutendexFn, archiveFn } = makeFetchers(targetPage)

    // Wraps one source: applies its results the moment they arrive.
    // Resolves true on success, false if that source failed (a failed
    // source just contributes nothing, the other one still shows).
    const track = (fn, setItems, setMore) =>
      fn().then(
        (r) => {
          if (!isCurrent()) return false
          setItems((prev) => (append ? [...prev, ...r.results] : r.results))
          setMore(!!r.next)
          setLoading(false)
          return true
        },
        () => {
          if (isCurrent()) setMore(false)
          return false
        }
      )

    if (!skipArchive) setArchiveLoading(true)
    const tasks = [
      skipGutendex ? Promise.resolve(false) : track(gutendexFn, setGutResults, setGutHasMore),
      skipArchive
        ? Promise.resolve(false)
        : track(archiveFn, setArchResults, setArchHasMore).finally(() => {
            if (isCurrent()) setArchiveLoading(false)
          }),
    ]
    const outcomes = await Promise.all(tasks)

    if (!isCurrent()) return
    if (!append && !outcomes.some(Boolean)) setError('Could not load books right now.')
    pageRef.current = targetPage
    setLoading(false)
    setLoadingMore(false)
  }, [])

  const loadPopular = useCallback(() => {
    const makeFetchers = (page) => ({
      gutendexFn: () => getPopularBooks({ page }),
      archiveFn: () => archive.getPopularBooks({ page }),
    })
    fetcherRef.current = makeFetchers
    runFetch(makeFetchers)
  }, [runFetch])

  const runSearch = useCallback((q) => {
    const makeFetchers = (page) => ({
      gutendexFn: () => searchBooks(q, { page }),
      archiveFn: () => archive.searchBooks(q, { page }),
    })
    fetcherRef.current = makeFetchers
    runFetch(makeFetchers)
  }, [runFetch])

  const runTopic = useCallback((topic) => {
    const makeFetchers = (page) => ({
      gutendexFn: () => getBooksByTopic(topic, { page }),
      archiveFn: () => archive.getBooksByTopic(topic, { page }),
    })
    fetcherRef.current = makeFetchers
    runFetch(makeFetchers)
  }, [runFetch])

  // Runs on first load, and whenever the URL itself changes (back/
  // forward navigation, or a pasted link), restoring whichever view
  // the URL actually describes.
  useEffect(() => {
    if (urlQuery) {
      runSearch(urlQuery)
    } else if (urlTopic) {
      runTopic(urlTopic)
    } else {
      loadPopular()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery, urlTopic])

  function handleSearch(e) {
    e.preventDefault()
    if (!query.trim()) {
      setSearchParams({})
      return
    }
    setSearchParams({ q: query })
  }

  function handleTopic(topic) {
    setQuery('')
    setSearchParams({ topic })
  }

  function handleLoadMore() {
    if (!fetcherRef.current) return
    // Skip a source that already ran out of pages, so it isn't asked for
    // a page that doesn't exist.
    runFetch(fetcherRef.current, {
      append: true,
      skipGutendex: !gutHasMore,
      skipArchive: !archHasMore,
    })
  }

  return (
    <div className="px-6 md:px-10 py-8 max-w-5xl mx-auto">
      <h1 className="font-display text-3xl text-ink mb-6">Discover</h1>

      <form onSubmit={handleSearch} className="relative mb-6">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles, authors, or subjects"
          className="w-full pl-11 pr-4 py-3 rounded-full border border-ink/15 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
      </form>

      <div className="flex gap-2 overflow-x-auto no-scrollbar mb-8 pb-1">
        {CURATED_TOPICS.map((topic) => (
          <button
            key={topic}
            onClick={() => handleTopic(topic)}
            className={`flex-shrink-0 px-4 py-1.5 rounded-full text-xs font-medium capitalize transition-colors ${
              activeTopic === topic
                ? 'bg-teal-600 text-white'
                : 'bg-ink/5 text-ink-muted hover:bg-ink/10'
            }`}
          >
            {topic}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-ink-muted gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading books...</span>
        </div>
      ) : error ? (
        <p className="text-sm text-red-600 text-center py-12">{error}</p>
      ) : results.length === 0 && !archiveLoading ? (
        <p className="text-sm text-ink-muted text-center py-12">No books found. Try a different search.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-5">
            {results.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>

          {archiveLoading && (
            <div className="flex items-center justify-center py-8 text-ink-muted gap-2">
              <Loader2 size={15} className="animate-spin" />
              <span className="text-xs">Searching Internet Archive...</span>
            </div>
          )}

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-lg border border-ink/15 hover:bg-ink/5 transition-colors disabled:opacity-60"
              >
                {loadingMore && <Loader2 size={15} className="animate-spin" />}
                {loadingMore ? 'Loading more...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
