import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Which build this is, shown on the Account page so it is easy to tell whether
// a phone is running the latest deploy. Vercel provides the commit at build time.
const BUILD = {
  commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7),
  time: new Date().toISOString(),
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(BUILD.commit),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(BUILD.time),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new version waits until the user taps "Reload" in the
      // banner (src/components/UpdatePrompt.jsx), so an update never reloads the
      // page in the middle of a book, an import or an OCR run.
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'icons/*.png'],
      manifest: {
        name: 'Folio',
        short_name: 'Folio',
        description: 'Your personal digital library',
        theme_color: '#2D6A5E',
        background_color: '#F7F5F0',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // PDF import (pdf.js and the converter) is large and rarely used, so
        // it is not part of the install download. It is cached the first
        // time a PDF is imported instead (see the rules below).
        globIgnores: ['**/assets/pdf-*.js', '**/assets/convert-*.js'],
        runtimeCaching: [
          {
            // pdf.js, its worker, and the converter, versioned by their file name
            urlPattern: ({ url }) =>
              url.origin === self.location.origin && /\/assets\/(pdf|convert|pdf\.worker\.min)-[^/]*\.m?js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-import-cache', expiration: { maxEntries: 12 } }
          },
          {
            // Tesseract's worker script and engine, fetched from a CDN on first use.
            // (The language data is kept in IndexedDB by Tesseract itself.)
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(tesseract\.js|tesseract\.js-core|@tesseract\.js-data)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-engine-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] },
            }
          },
          {
            urlPattern: /^https:\/\/gutendex\.com\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'gutendex-cache', expiration: { maxEntries: 100, maxAgeSeconds: 86400 } }
          },
          {
            urlPattern: /^https:\/\/www\.gutenberg\.org\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'book-content-cache', expiration: { maxEntries: 50, maxAgeSeconds: 2592000 } }
          },
        ]
      }
    })
  ],
})
