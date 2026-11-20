import { useEffect, useId } from 'react'

// A small dialog over a softly blurred page, in the app's own look: parchment card, display
// serif title. Escape and a click outside close it. Used for naming a folder, confirming a
// delete and choosing where to move books.
export default function Modal({ title, onClose, children }) {
  const titleId = useId()
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-sm rounded-2xl bg-parchment border border-ink/10 shadow-2xl p-6 max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <h2 id={titleId} className="font-display text-2xl text-ink mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}
