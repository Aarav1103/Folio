import { useState, useMemo } from 'react'
import { useLibrary } from '../contexts/LibraryContext'
import BookCard from '../components/BookCard'
import ImportEpubButton from '../components/ImportEpubButton'
import { sortByRecency } from '../lib/recency'

export default function Collection() {
  const { collection, progressMap } = useLibrary()
  const [query, setQuery] = useState('')

  // Most recently added or read first
  const ordered = useMemo(() => sortByRecency(collection, progressMap), [collection, progressMap])

  const filtered = useMemo(() => {
    if (!query.trim()) return ordered
    const q = query.toLowerCase()
    return ordered.filter(
      (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
    )
  }, [ordered, query])

  return (
    <div className="px-6 md:px-10 py-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <h1 className="font-display text-3xl text-ink">Your library</h1>
        <ImportEpubButton />
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your collection"
        className="w-full px-4 py-2.5 rounded-full border border-ink/15 bg-white text-sm mb-8 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
      />

      {filtered.length === 0 ? (
        <p className="text-ink-muted text-sm text-center py-16">
          {collection.length === 0 ? 'No books yet. Head to Discover to add some.' : 'No matches found.'}
        </p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-5">
          {filtered.map((book) => (
            <BookCard key={book.id} book={book} progress={progressMap[book.id]?.percentage} size="grid" />
          ))}
        </div>
      )}
    </div>
  )
}
