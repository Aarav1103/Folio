// Receives files shared to Folio from another app, on a phone: choosing Share on an
// .epub or .pdf in the file manager lists Folio (the web app manifest's "share_target",
// see vite.config.js). The files arrive as a form POST to /share-target. They are kept in
// a cache, and the browser is sent on to the app, which imports them (src/lib/sharedFiles.js).
//
// This file is pulled into the generated service worker with importScripts, so it
// runs in the same worker as the offline cache.

const SHARED_CACHE = 'folio-shared-files'

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'POST') return
  if (new URL(request.url).pathname !== '/share-target') return
  event.respondWith(receiveSharedFiles(request))
})

async function receiveSharedFiles(request) {
  try {
    const form = await request.formData()
    const cache = await caches.open(SHARED_CACHE)
    const stamp = Date.now()
    let count = 0
    for (const value of form.getAll('books')) {
      if (typeof value === 'string') continue // only files
      // the file's name travels in a header (a cached response has no file name of its own)
      await cache.put(
        `/shared-file/${stamp}-${String(count).padStart(3, '0')}`,
        new Response(value, {
          headers: {
            'content-type': value.type || 'application/octet-stream',
            'x-file-name': encodeURIComponent(value.name || 'shared-file'),
          },
        }),
      )
      count++
    }
    return Response.redirect(`/?shared=${count}`, 303)
  } catch (err) {
    console.error('Receiving shared files failed', err)
    return Response.redirect('/?shared=error', 303)
  }
}
