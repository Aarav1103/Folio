// Small rules for dragging in the library (see src/lib/useLibraryDrag.js). Nothing here
// touches the browser, so they can be tested alone.

// Which side of a tile a pointer is on: dropping on the left half puts the dragged folder
// before it, on the right half after it.
export function dropEdge(rect, x) {
  return x < rect.left + rect.width / 2 ? 'before' : 'after'
}

// How fast to scroll the page while something is dragged near its top or bottom edge:
// negative scrolls up, positive scrolls down, 0 in the middle. Faster the closer to the edge.
const EDGE_ZONE = 72 // px
const MAX_SPEED = 18 // px per frame
export function autoScrollSpeed(y, viewportHeight) {
  if (y < EDGE_ZONE) return -Math.ceil((MAX_SPEED * (EDGE_ZONE - Math.max(y, 0))) / EDGE_ZONE)
  if (y > viewportHeight - EDGE_ZONE) return Math.ceil((MAX_SPEED * (y - (viewportHeight - EDGE_ZONE))) / EDGE_ZONE)
  return 0
}

// The books a drag of one book carries: all the selected ones if that book is one of several
// selected, otherwise just that book.
export function booksToDrag(bookId, selected) {
  return selected.size > 1 && selected.has(bookId) ? [...selected] : [bookId]
}
