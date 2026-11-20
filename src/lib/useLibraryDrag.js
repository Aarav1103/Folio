import { useEffect, useRef, useState } from 'react'
import { dropEdge, autoScrollSpeed } from './dragDrop'

// Dragging in the library, with a mouse or a finger.
//
// What can be picked up: an element with data-drag-kind="book" or "folder" and data-drag-id.
// Where it can be dropped (found by looking at what is under the pointer):
//   data-drop-folder="<id>"   a folder: a book dropped here goes into it; a folder dropped here
//                             goes before or after it (left or right half)
//   data-drop-root            "the library" (not in a folder): a book dropped here is taken out
//
// A mouse drag starts after the pointer has moved a few pixels. On a touch screen a drag starts
// after holding a finger still for a moment (moving first means scrolling, as always), and the
// page then stays put under the finger. Escape, or the browser taking the touch back, cancels.
// A tap or click that did not turn into a drag is left alone and works as before.
//
// The picked-up thing is shown as a copy that follows the pointer; the original is dimmed, and
// the place it would go is marked. These marks are set directly on the elements (data
// attributes, styled in index.css) rather than through React state, so dragging stays smooth.
// Only `dragging` (what kind of thing, or null) is state, for things that appear while a drag
// is under way.

const LONG_PRESS_MS = 380
const TOUCH_SLOP_PX = 10 // a finger that moves this much before the hold is up is scrolling
const MOUSE_START_PX = 6

// handlers (kept current without restarting the listeners):
//   enabled()                       whether dragging is allowed now
//   booksFor(bookId)                the book ids a drag of that book carries
//   canReorder()                    whether folders may be dragged into a new order now
//   onDropBooks(ids, folderId|null) books were dropped on a folder (or on "the library": null)
//   onReorderFolder(id, targetId, 'before'|'after')
export function useLibraryDrag(handlers) {
  const [dragging, setDragging] = useState(null)
  const latest = useRef(handlers)
  useEffect(() => { latest.current = handlers })

  useEffect(() => {
    let pending = null // pointer is down on an item, not yet a drag
    let drag = null // a drag under way
    let raf = 0

    const clearMarks = () => {
      document.querySelectorAll('[data-drop-hover], [data-drop-edge]').forEach((el) => {
        el.removeAttribute('data-drop-hover')
        el.removeAttribute('data-drop-edge')
      })
    }

    function findTarget(x, y) {
      for (const el of document.elementsFromPoint(x, y)) {
        const folderEl = el.closest('[data-drop-folder]')
        if (folderEl) {
          if (drag.kind === 'folder' && !latest.current.canReorder()) return null
          if (drag.kind === 'folder' && folderEl.dataset.dropFolder === drag.id) return null // not onto itself
          return { el: folderEl, folderId: folderEl.dataset.dropFolder, edge: drag.kind === 'folder' ? dropEdge(folderEl.getBoundingClientRect(), x) : null }
        }
        const rootEl = el.closest('[data-drop-root]')
        if (rootEl && drag.kind === 'book') return { el: rootEl, folderId: null, edge: null }
      }
      return null
    }

    function refresh(x, y) {
      drag.x = x
      drag.y = y
      // smaller than the real thing, so the place it is about to go stays in sight
      drag.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -55%) rotate(-3deg) scale(0.62)`
      const target = findTarget(x, y)
      clearMarks()
      drag.target = target
      if (!target) return
      if (drag.kind === 'folder') target.el.setAttribute('data-drop-edge', target.edge)
      else target.el.setAttribute('data-drop-hover', 'true')
    }

    function makeGhost(item, count) {
      const cover = item.querySelector('button > div') || item
      const rect = cover.getBoundingClientRect()
      const ghost = cover.cloneNode(true)
      ghost.removeAttribute('class')
      ghost.className = 'drag-ghost'
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      ghost.setAttribute('aria-hidden', 'true')
      if (count > 1) {
        const badge = document.createElement('span')
        badge.className = 'drag-ghost-count'
        badge.textContent = String(count)
        ghost.appendChild(badge)
      }
      document.body.appendChild(ghost)
      return ghost
    }

    const blockScroll = (e) => { if (drag && e.cancelable) e.preventDefault() }
    const blockMenu = (e) => { if (pending || drag) e.preventDefault() } // a long press must not open the browser's menu
    const blockNativeDrag = (e) => { if (e.target.closest && e.target.closest('[data-drag-id]')) e.preventDefault() }

    function loop() {
      if (!drag) return
      const speed = autoScrollSpeed(drag.y, window.innerHeight)
      if (speed !== 0) {
        window.scrollBy(0, speed)
        refresh(drag.x, drag.y) // what is under the pointer has moved
      }
      raf = requestAnimationFrame(loop)
    }

    function begin(x, y) {
      const { item } = pending
      const kind = item.dataset.dragKind
      const id = item.dataset.dragId
      if (kind === 'folder' && !latest.current.canReorder()) { stop(); return }
      const ids = kind === 'book' ? latest.current.booksFor(id) : [id]
      drag = { kind, id, ids, item, pointerId: pending.pointerId, ghost: makeGhost(item, ids.length), x, y, target: null }
      clearTimeout(pending.timer)
      pending = null
      item.setAttribute('data-dragging', 'true')
      if (navigator.vibrate) navigator.vibrate(12)
      setDragging({ kind })
      refresh(x, y)
      raf = requestAnimationFrame(loop)
    }

    function stop() {
      if (pending) clearTimeout(pending.timer)
      if (drag) {
        drag.ghost.remove()
        drag.item.removeAttribute('data-dragging')
        cancelAnimationFrame(raf)
      }
      clearMarks()
      pending = null
      drag = null
      setDragging(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('touchmove', blockScroll)
      window.removeEventListener('keydown', onKey)
    }

    function onDown(e) {
      if (pending || drag || !latest.current.enabled()) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const item = e.target.closest && e.target.closest('[data-drag-id]')
      if (!item || e.target.closest('[aria-haspopup="menu"], input, textarea')) return
      pending = { item, pointerId: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: 0 }
      if (e.pointerType !== 'mouse') pending.timer = setTimeout(() => { if (pending) begin(pending.x, pending.y) }, LONG_PRESS_MS)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('touchmove', blockScroll, { passive: false })
      window.addEventListener('keydown', onKey)
    }

    function onMove(e) {
      if (pending && e.pointerId === pending.pointerId) {
        pending.x = e.clientX
        pending.y = e.clientY
        const moved = Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0)
        if (pending.type === 'mouse') { if (moved >= MOUSE_START_PX) begin(e.clientX, e.clientY) }
        else if (moved > TOUCH_SLOP_PX) stop() // the finger moved first: it is a scroll
      } else if (drag && e.pointerId === drag.pointerId) {
        refresh(e.clientX, e.clientY)
      }
    }

    function onUp(e) {
      if (!drag) { if (pending && e.pointerId === pending.pointerId) stop(); return }
      if (e.pointerId !== drag.pointerId) return
      const { kind, id, ids, target } = drag
      stop()
      // The click the browser sends right after a drag must not open the book or folder that was
      // dragged. Only that one click is stopped (and only if it comes at once), so a click on
      // anything else a moment later is not lost.
      // The click the browser sends right after a drag must not open the book or folder that was
      // dragged. It comes within a few milliseconds of the drop, so only a click that soon is
      // stopped: a click on something else a moment later is not lost (and if the dragged card
      // was moved away, so that no such click comes, nothing is left waiting to eat the next one).
      const droppedAt = performance.now()
      const swallow = (ev) => { if (performance.now() - droppedAt < 80) { ev.stopPropagation(); ev.preventDefault() } }
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true), 120)
      if (!target) return
      if (kind === 'book') latest.current.onDropBooks(ids, target.folderId)
      else latest.current.onReorderFolder(id, target.folderId, target.edge)
    }

    function onCancel() { stop() }
    function onKey(e) { if (e.key === 'Escape') stop() }

    document.addEventListener('pointerdown', onDown)
    document.addEventListener('contextmenu', blockMenu, true)
    document.addEventListener('dragstart', blockNativeDrag)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('contextmenu', blockMenu, true)
      document.removeEventListener('dragstart', blockNativeDrag)
      stop()
    }
  }, [])

  return { dragging }
}
