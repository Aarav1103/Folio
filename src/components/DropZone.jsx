import { useEffect, useRef, useState } from 'react'

// Files dropped anywhere on the window are added to the library, with no need to press
// Import first. While files are being dragged over the window the page behind blurs and
// goes translucent, with one line of text (the look is the .drop-veil rules in index.css).
//
// Dropping a file on a web page normally makes the browser open it, leaving the app, so
// every file drop is taken over here even where nothing is imported (signed out, or in a
// book). Drags of anything but files (text, a link, a picture from a page) are left alone.
//
// `allowed`: files are imported. `signedIn`: used only for the message when they are not.
export default function DropZone({ allowed, signedIn, onFiles, onRefused }) {
  const [dragging, setDragging] = useState(false)
  const hideTimer = useRef(null)
  // the latest props, for the listeners (which are added only once)
  const latest = useRef({ allowed, signedIn, onFiles, onRefused })
  useEffect(() => { latest.current = { allowed, signedIn, onFiles, onRefused } })

  useEffect(() => {
    const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
    const hideSoon = () => {
      clearTimeout(hideTimer.current)
      // dragover keeps arriving (about every 350 ms, even if the mouse is still) while the
      // drag is over the window; if it stops, the drag has gone, however it left
      hideTimer.current = setTimeout(() => setDragging(false), 1000)
    }
    const show = () => { if (latest.current.allowed) { setDragging(true); hideSoon() } }

    const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); show() }
    const onDragOver = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault() // makes the window a place a drop is accepted
      e.dataTransfer.dropEffect = latest.current.allowed ? 'copy' : 'none'
      show()
    }
    const onDragLeave = (e) => {
      if (!hasFiles(e)) return
      // leaving through the edge of the window
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        clearTimeout(hideTimer.current)
        setDragging(false)
      }
    }
    const onDrop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      clearTimeout(hideTimer.current)
      setDragging(false)
      const { allowed: ok, signedIn: inAccount, onFiles: take, onRefused: refuse } = latest.current
      const files = Array.from(e.dataTransfer.files || [])
      if (files.length === 0) return
      if (ok) take(files)
      else if (!inAccount) refuse('Sign in to add books to your library.')
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      clearTimeout(hideTimer.current)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // always in the page, hidden until a drag arrives, so that it can fade in and out
  return (
    <div className={`drop-veil${dragging ? ' is-on' : ''}`} aria-hidden={!dragging}>
      <p className="font-display italic text-4xl md:text-5xl text-ink text-center">Drop to add to your library</p>
    </div>
  )
}
