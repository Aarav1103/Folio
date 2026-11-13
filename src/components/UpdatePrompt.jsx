import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'

// How often a running app asks the server whether there is a newer version.
// It also asks every time the app is brought back to the foreground, which is
// what matters on a phone where the app can stay open for days.
const CHECK_EVERY_MS = 30 * 60 * 1000

// Tells the user a new version is ready and lets them switch to it. The new
// version is downloaded in the background; nothing reloads until "Reload" is
// tapped, so a book, an import or an OCR run is never interrupted.
export default function UpdatePrompt() {
  const [registration, setRegistration] = useState(null)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setRegistration(reg)
    },
  })
  const { pathname } = useLocation()

  useEffect(() => {
    if (!registration) return
    const check = () => {
      if (navigator.onLine) registration.update().catch(() => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    const timer = setInterval(check, CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [registration])

  // Not while reading: a banner over the text is worse than waiting a moment.
  // It is still pending and shows as soon as the reader is closed.
  if (!needRefresh || pathname.startsWith('/read/')) return null

  return (
    <div
      role="status"
      className="fixed left-3 right-3 bottom-20 md:bottom-4 md:left-auto md:right-4 md:w-80 z-50 flex items-center gap-3 rounded-xl bg-ink text-white px-4 py-3 shadow-lg"
    >
      <p className="flex-1 text-sm">A new version of Folio is ready.</p>
      <button
        onClick={() => setNeedRefresh(false)}
        className="text-xs text-white/70 hover:text-white px-2 py-1"
      >
        Later
      </button>
      <button
        onClick={() => updateServiceWorker(true)}
        className="text-xs font-medium bg-teal-500 hover:bg-teal-400 text-white rounded-lg px-3 py-1.5"
      >
        Reload
      </button>
    </div>
  )
}
