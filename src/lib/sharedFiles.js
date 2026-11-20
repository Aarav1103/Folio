// Files that another app shared to Folio (see public/share-target-sw.js, which keeps
// them in a cache). Taking them removes them from the cache, so each is imported once.

const SHARED_CACHE = 'folio-shared-files'

let inFlight = null
// Entries already handed out in this page's life. If removing one from the cache ever
// failed, it would otherwise be taken and imported again on every check, without end.
const handedOut = new Set()

// Returns the waiting files as File objects, oldest first (an empty list if there are
// none, or if the browser has no cache storage). Never throws.
export function takeSharedFiles() {
  // two callers at once (start-up and returning to the app) must not both take the same file
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      if (typeof caches === 'undefined') return []
      const cache = await caches.open(SHARED_CACHE)
      const requests = (await cache.keys()).sort((a, b) => a.url.localeCompare(b.url))
      const files = []
      for (const request of requests) {
        if (handedOut.has(request.url)) continue
        const response = await cache.match(request)
        if (!response) continue
        handedOut.add(request.url)
        const blob = await response.blob()
        let name = 'shared-file'
        try { name = decodeURIComponent(response.headers.get('x-file-name') || name) } catch { /* keep the default */ }
        files.push(new File([blob], name, { type: response.headers.get('content-type') || blob.type || '' }))
        await cache.delete(request)
      }
      return files
    } catch (err) {
      console.error('Could not read shared files', err)
      return []
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
