import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

const MENU_WIDTH = 176 // px
const ROW_HEIGHT = 40 // px, a menu item
const EDGE = 8 // px kept clear of the screen's edge

// A small "..." button that opens a short list of actions. The list is placed against the
// button but always kept on the screen (a card in the first column of a phone is narrower
// than the list), and opens upward near the bottom. It closes on a click elsewhere, on
// Escape, on scrolling, and after choosing. `items`: [{ label, onSelect, danger }].
export default function ActionMenu({ label, items, className = '' }) {
  const [place, setPlace] = useState(null) // { left, top } while open
  const root = useRef(null)
  const button = useRef(null)
  const open = place !== null

  useEffect(() => {
    if (!open) return undefined
    const close = () => setPlace(null)
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  function toggle() {
    if (open) { setPlace(null); return }
    const r = button.current.getBoundingClientRect()
    const height = items.length * ROW_HEIGHT + 12
    const left = Math.min(Math.max(EDGE, r.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - EDGE)
    const below = r.bottom + 6
    const top = below + height > window.innerHeight - EDGE ? Math.max(EDGE, r.top - 6 - height) : below
    setPlace({ left, top })
  }

  return (
    <div ref={root} className={className}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        // shown on hover or focus on a computer, always on a touch screen (there is no hover)
        className={`w-8 h-8 flex items-center justify-center rounded-full bg-parchment/90 text-ink shadow-md backdrop-blur-sm transition-opacity hover:bg-parchment focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${open ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'}`}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{ position: 'fixed', left: place.left, top: place.top, width: MENU_WIDTH }}
          className="z-[65] rounded-xl bg-parchment border border-ink/10 shadow-xl py-1.5"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              onClick={() => { setPlace(null); item.onSelect() }}
              className={`block w-full text-left px-4 h-10 text-sm hover:bg-ink/5 transition-colors ${item.danger ? 'text-red-600' : 'text-ink'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
