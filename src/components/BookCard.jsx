import { useNavigate } from 'react-router-dom'

export default function BookCard({ book, progress, size = 'md' }) {
  const navigate = useNavigate()

const dims = {
    sm: 'w-24',
    md: 'w-32 sm:w-36',
    lg: 'w-40 sm:w-48',
    grid: 'w-full',
  }[size]

  return (
    <button
      onClick={() => navigate(`/book/${book.id}`)}
      // 'grid' cards fill whatever box they are put in (a grid column, or a fixed-width
      // wrapper in a scrolling row). w-full matters outside a grid: without it the card
      // is only as wide as its cover image's own pixel size and the title.
      className={`group text-left focus:outline-none ${size === 'grid' ? 'min-w-0 w-full' : 'flex-shrink-0'}`}
    >
      
      <div className={`${dims} relative rounded-sm overflow-hidden shadow-md bg-ink/5 transition-transform duration-200 group-hover:-translate-y-1 group-hover:shadow-xl`}>
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
      </div>

      <div className={`${dims} mt-2`}>
        <p className="font-body text-sm font-medium text-ink truncate leading-snug">
          {book.title}
        </p>
        <p className="font-body text-xs text-ink-muted truncate mt-0.5">
          {book.author}
        </p>
      </div>
    </button>
  )
}
