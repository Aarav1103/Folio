import { useState, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, FolderPlus, ListChecks, Pencil, Trash2, X } from 'lucide-react'
import { useLibrary } from '../contexts/LibraryContext'
import { useFolders } from '../contexts/foldersContext'
import BookCard from '../components/BookCard'
import FolderTile from '../components/FolderTile'
import FolderNameDialog from '../components/FolderNameDialog'
import FolderPicker from '../components/FolderPicker'
import ConfirmDialog from '../components/ConfirmDialog'
import ImportEpubButton from '../components/ImportEpubButton'
import { buildLayout, folderOfBook } from '../lib/folders'
import { sortByRecency } from '../lib/recency'

const GRID = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-5'

// The library: folders first (in the order you arranged them), then the books that are in no
// folder, most recently added or read first. A folder opens to show its own books. Books are
// moved with the "..." menu on a book, or with Select to move several at once.
export default function Collection() {
  const { collection, progressMap } = useLibrary()
  const { folders, placements, createFolder, renameFolder, deleteFolder, moveBooks } = useFolders()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [dialog, setDialog] = useState(null) // { type: 'new' | 'rename' | 'delete' | 'move', ... }

  const layout = useMemo(() => buildLayout(collection, folders, placements, progressMap), [collection, folders, placements, progressMap])
  const folderId = params.get('folder')
  // a folder that was deleted (on another device, say) while it was open: show the library
  const openFolder = folderId ? layout.folders.find((f) => f.id === folderId) || null : null

  const q = query.trim().toLowerCase()
  const matches = useCallback((b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q), [q])

  // What is shown. Searching looks through everything you can see: inside a folder, that
  // folder's books; in the library, every book, including those in folders.
  const view = useMemo(() => {
    if (openFolder) return { folders: [], books: q ? openFolder.books.filter(matches) : openFolder.books }
    if (!q) return { folders: layout.folders, books: layout.loose }
    const everyBook = [...layout.loose, ...layout.folders.flatMap((f) => f.books)]
    return {
      folders: layout.folders.filter((f) => f.name.toLowerCase().includes(q)),
      // most recent first, whichever folder a book is in
      books: sortByRecency(everyBook.filter(matches), progressMap),
    }
  }, [openFolder, layout, q, matches, progressMap])

  function open(id) { setQuery(''); setParams(id ? { folder: id } : {}) }
  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function stopSelecting() { setSelecting(false); setSelected(new Set()) }

  const bookMenu = (book) => {
    const items = [{ label: 'Move to folder...', onSelect: () => setDialog({ type: 'move', bookIds: [book.id] }) }]
    if (folderOfBook(book.id, folders, placements)) items.push({ label: 'Take out of folder', onSelect: () => moveBooks([book.id], null) })
    items.push({ label: 'Select', onSelect: () => { setSelecting(true); setSelected(new Set([book.id])) } })
    return items
  }
  const folderMenu = (folder) => [
    { label: 'Rename', onSelect: () => setDialog({ type: 'rename', folder }) },
    { label: 'Delete folder', danger: true, onSelect: () => setDialog({ type: 'delete', folder }) },
  ]

  const empty = view.folders.length === 0 && view.books.length === 0
  const emptyText = q
    ? 'No matches found.'
    : openFolder
      ? 'This folder is empty. Use the ... menu on a book in your library, or Select, to move books here.'
      : 'No books yet. Head to Discover to add some.'

  return (
    <div className="px-6 md:px-10 py-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          {openFolder && (
            <button onClick={() => open(null)} className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors mb-2">
              <ArrowLeft size={15} /> Your library
            </button>
          )}
          <h1 className="font-display text-3xl text-ink break-words">{openFolder ? openFolder.name : 'Your library'}</h1>
          {openFolder && (
            <div className="flex items-center gap-1 mt-2 -ml-2">
              <button onClick={() => setDialog({ type: 'rename', folder: openFolder })} className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink hover:bg-ink/5 px-2 py-1 rounded-md transition-colors">
                <Pencil size={14} /> Rename
              </button>
              <button onClick={() => setDialog({ type: 'delete', folder: openFolder })} className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-red-600 hover:bg-ink/5 px-2 py-1 rounded-md transition-colors">
                <Trash2 size={14} /> Delete folder
              </button>
            </div>
          )}
        </div>
        <ImportEpubButton />
      </div>

      <div className="flex items-center gap-2 mb-8">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={openFolder ? 'Search this folder' : 'Search your collection'}
          className="flex-1 min-w-0 px-4 py-2.5 rounded-full border border-ink/15 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
        {collection.length > 0 && (
          <button
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            aria-pressed={selecting}
            className={`flex items-center gap-2 border text-sm font-medium px-3.5 py-2.5 rounded-full transition-colors ${selecting ? 'bg-teal-600 border-teal-600 text-white' : 'border-ink/15 hover:bg-ink/5'}`}
          >
            <ListChecks size={16} /> <span className="hidden sm:inline">Select</span>
          </button>
        )}
        {!openFolder && (
          <button
            onClick={() => setDialog({ type: 'new' })}
            className="flex items-center gap-2 border border-ink/15 text-sm font-medium px-3.5 py-2.5 rounded-full hover:bg-ink/5 transition-colors"
          >
            <FolderPlus size={16} /> <span className="hidden sm:inline">New folder</span><span className="sr-only sm:hidden">New folder</span>
          </button>
        )}
      </div>

      {empty ? (
        <p className="text-ink-muted text-sm text-center py-16">{emptyText}</p>
      ) : (
        <div className={GRID}>
          {view.folders.map((folder) => (
            <FolderTile key={folder.id} folder={folder} onOpen={() => open(folder.id)} menuItems={folderMenu(folder)} />
          ))}
          {view.books.map((book) => {
            const folder = !openFolder && q ? folderOfBook(book.id, folders, placements) : null
            return (
              <BookCard
                key={book.id}
                book={book}
                progress={progressMap[book.id]?.percentage}
                size="grid"
                note={folder ? `In ${folder.name}` : undefined}
                menuItems={bookMenu(book)}
                selectMode={selecting}
                selected={selected.has(book.id)}
                onToggleSelect={toggle}
              />
            )
          })}
        </div>
      )}

      {selecting && (
        <div role="toolbar" aria-label="Selected books" className="fixed left-1/2 -translate-x-1/2 bottom-20 md:bottom-6 z-40 flex items-center gap-1 rounded-full bg-ink text-parchment shadow-xl pl-5 pr-2 py-2">
          <span className="text-sm mr-2 whitespace-nowrap">{selected.size} selected</span>
          <button
            onClick={() => setDialog({ type: 'move', bookIds: [...selected] })}
            disabled={selected.size === 0}
            className="text-sm font-medium px-3.5 py-1.5 rounded-full bg-teal-500 hover:bg-teal-400 text-white transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            Move to folder
          </button>
          <button onClick={stopSelecting} aria-label="Stop selecting" className="p-2 rounded-full hover:bg-white/10 transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {dialog && dialog.type === 'new' && (
        <FolderNameDialog
          title="New folder"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => { await createFolder(name); setDialog(null) }}
        />
      )}
      {dialog && dialog.type === 'rename' && (
        <FolderNameDialog
          title="Rename folder"
          initial={dialog.folder.name}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => { await renameFolder(dialog.folder.id, name); setDialog(null) }}
        />
      )}
      {dialog && dialog.type === 'delete' && (
        <ConfirmDialog
          title="Delete folder?"
          message={`"${dialog.folder.name}" will be deleted. ${dialog.folder.books.length === 0 ? 'It is empty.' : `Its ${dialog.folder.books.length === 1 ? 'book goes' : `${dialog.folder.books.length} books go`} back to your library.`} No books are removed.`}
          confirmLabel="Delete folder"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const id = dialog.folder.id
            setDialog(null)
            await deleteFolder(id)
            if (folderId === id) open(null)
          }}
        />
      )}
      {dialog && dialog.type === 'move' && (
        <FolderPicker
          bookIds={dialog.bookIds}
          onClose={(moved) => { setDialog(null); if (moved) stopSelecting() }}
        />
      )}
    </div>
  )
}
