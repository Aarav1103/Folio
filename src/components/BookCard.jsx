import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import ActionMenu from './ActionMenu'

// A book cover with its title and author. In the library it can also have a "..." menu
// (`menuItems`), a small line under the author (`note`, the folder it is in, in search
// results), and a selecting mode (`selectMode`) where a tap marks it instead of opening it.
export default function BookCard({ book, progress, size = 'md', note, menuItems, selectMode = false, selected = false, onToggleSelect }) {
  const navigate = useNavigate()

const dims = {
    sm: 'w-24',
    md: 'w-32 sm:w-36',
    lg: 'w-40 sm:w-48',
    grid: 'w-full',
  }[size]

  const card = (
    <button
      onClick={selectMode ? () => onToggleSelect && onToggleSelect(book.id) : () => navigate(`/book/${book.id}`)}
      aria-pressed={selectMode ? selected : undefined}
      // 'grid' cards fill whatever box they are put in (a grid column, or a fixed-width
      // wrapper in a scrolling row). w-full matters outside a grid: without it the card
      // is only as wide as its cover image's own pixel size and the title.
      className={`group text-left focus:outline-none ${size === 'grid' ? 'min-w-0 w-full' : 'flex-shrink-0'}`}
    >
      
      <div className={`${dims} relative rounded-sm overflow-hidden shadow-md bg-ink/5 transition-transform duration-200 group-hover:-translate-y-1 group-hover:shadow-xl ${selected ? 'ring-2 ring-teal-600 ring-offset-2 ring-offset-parchment' : ''}`}>
        {book.cover ? (
          <img
            src={book.cover}
            alt={book.title}
            className="w-full aspect-[2/3] object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full aspect-[2/3] flex items-center justify-center bg-gradient-to-br from-teal-100 to-parchment p-3">
            <span className="font-display text-sm text-teal-600 text-center leading-tight line-clamp-5">
              {book.title}
            </span>
          </div>
        )}

        {typeof progress === 'number' && progress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
            <div
              className="h-full bg-teal-500"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        )}

        {selectMode && (
          <span
            aria-hidden="true"
            className={`absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center shadow ${selected ? 'bg-teal-600 border-teal-600 text-white' : 'bg-black/25 border-white'}`}
          >
            {selected && <Check size={14} strokeWidth={3} />}
          </span>
        )}
      </div>

      <div className={`${dims} mt-2`}>
        <p className="font-body text-sm font-medium text-ink truncate leading-snug">
          {book.title}
        </p>
        <p className="font-body text-xs text-ink-muted truncate mt-0.5">
          {book.author}
        </p>
        {note && <p className="font-body text-xs text-teal-600 truncate mt-0.5">{note}</p>}
      </div>
    </button>
  )

  // Everywhere else a card is just the button, as it always was
  if (!menuItems && !selectMode) return card
  return (
    <div className="group/card relative min-w-0 w-full">
      {card}
      {!selectMode && menuItems && (
        <ActionMenu label={`Options for ${book.title}`} items={menuItems} className="absolute right-1.5 top-1.5" />
      )}
    </div>
  )
}
