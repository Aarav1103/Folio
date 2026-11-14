import { useMemo } from 'react'
import { useLibrary } from '../contexts/LibraryContext'
import BookCard from '../components/BookCard'
import ImportEpubButton from '../components/ImportEpubButton'
import { sortByRecency } from '../lib/recency'
import { useNavigate } from 'react-router-dom'

// Widths in the Currently reading row, worked out from the collection grid below it
// (3, 4 or 5 columns across with a 1.25rem gap), so the cards line up with it.
// The book read most recently comes first and is drawn a little larger (1.4 columns
// wide), like a "pick up where you left off" card. The row scrolls sideways, and the
// next card peeking in at the edge shows that it does.
const CARD_WIDTH = 'w-[calc((100%-2.5rem)/3)] sm:w-[calc((100%-3.75rem)/4)] md:w-[calc((100%-5rem)/5)]'
const LEAD_CARD_WIDTH = 'w-[calc((100%-2.5rem)/3*1.4)] sm:w-[calc((100%-3.75rem)/4*1.4)] md:w-[calc((100%-5rem)/5*1.4)]'

export default function Home() {
  const { collection, progressMap, isOnline, syncing } = useLibrary()
  const navigate = useNavigate()

  const currentlyReading = useMemo(() => {
    return collection
      .filter((b) => progressMap[b.id] && progressMap[b.id].percentage < 99)
      .sort((a, b) => (progressMap[b.id]?.updatedAt || 0) - (progressMap[a.id]?.updatedAt || 0))
  }, [collection, progressMap])

  const shelf = useMemo(() => sortByRecency(collection, progressMap), [collection, progressMap])

  return (
    <div className="px-6 md:px-10 py-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-3xl text-ink">Your shelf</h1>
          <p className="text-ink-muted text-sm mt-1">
            {isOnline ? (syncing ? 'Syncing...' : 'Up to date') : 'Offline, changes will sync when you reconnect'}
          </p>
        </div>
        <ImportEpubButton />
      </div>

      {currentlyReading.length > 0 && (
        <section className="mb-10">
          <h2 className="font-body text-sm font-semibold text-ink-muted uppercase tracking-wide mb-4">
            Currently reading
          </h2>
          <div className="flex gap-5 overflow-x-auto no-scrollbar pb-2">
            {currentlyReading.map((book, i) => (
              <div key={book.id} className={`flex-shrink-0 ${i === 0 ? LEAD_CARD_WIDTH : CARD_WIDTH}`}>
                <BookCard
                  book={book}
                  progress={progressMap[book.id]?.percentage}
                  size="grid"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-body text-sm font-semibold text-ink-muted uppercase tracking-wide mb-4">
          Your collection
        </h2>

        {shelf.length === 0 ? (
          <div className="border border-dashed border-ink/15 rounded-xl py-16 px-6 text-center">
            <p className="font-display text-lg text-ink mb-2">Your shelf is empty</p>
            <p className="text-ink-muted text-sm mb-5">
              Find your first book from thousands of free, public domain titles.
            </p>
            <button
              onClick={() => navigate('/discover')}
              className="bg-teal-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-teal-500 transition-colors"
            >
              Discover books
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-5">
            {shelf.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                progress={progressMap[book.id]?.percentage}
                size="grid"
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
