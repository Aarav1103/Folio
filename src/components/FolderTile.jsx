import ActionMenu from './ActionMenu'

// A folder in the library grid: a card showing the covers of up to four of its books,
// with its name and how many books it holds. Same size as a book card, so they line up.
export default function FolderTile({ folder, onOpen, menuItems }) {
  const books = folder.books
  const count = books.length
  return (
    <div className="group/card relative min-w-0 w-full" data-drag-kind="folder" data-drag-id={folder.id} data-drop-folder={folder.id}>
      <button onClick={onOpen} className="group text-left focus:outline-none min-w-0 w-full" aria-label={`Open folder ${folder.name}, ${count} ${count === 1 ? 'book' : 'books'}`}>
        <div className="relative w-full aspect-[2/3] rounded-md bg-teal-100 shadow-md p-2 grid grid-cols-2 grid-rows-2 gap-1.5 transition-transform duration-200 group-hover:-translate-y-1 group-hover:shadow-xl">
          {[0, 1, 2, 3].map((i) => {
            const book = books[i]
            if (!book) return <div key={i} className="rounded-[3px] bg-parchment/50" />
            return book.cover ? (
              <img key={book.id} src={book.cover} alt="" className="w-full h-full object-cover rounded-[3px] shadow-sm" loading="lazy" draggable={false} />
            ) : (
              <div key={book.id} className="w-full h-full rounded-[3px] bg-gradient-to-br from-parchment to-teal-100/60 flex items-center justify-center p-1 shadow-sm overflow-hidden">
                <span className="font-display text-[9px] leading-tight text-teal-600 text-center line-clamp-4">{book.title}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-2">
          <p className="font-body text-sm font-medium text-ink truncate leading-snug">{folder.name}</p>
          <p className="font-body text-xs text-ink-muted truncate mt-0.5">{count} {count === 1 ? 'book' : 'books'}</p>
        </div>
      </button>
      {menuItems && <ActionMenu label={`Folder options for ${folder.name}`} items={menuItems} className="absolute right-1.5 top-1.5" />}
    </div>
  )
}
