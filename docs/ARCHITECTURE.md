# Folio: technical description

Folio is a personal digital library, built as a single-page web app that installs as a PWA. You search public-domain books, save them to a collection, read them in the app, and pick up where you left off on any device. Books you download or import work with no connection.

This document describes how the project is put together and, mainly, what lives where: which code runs in the browser, which on a server, and where each piece of data is stored. It reflects the code on the `claude/repo-exploration-vhswzs` branch.

Contents

1. [System at a glance](#1-system-at-a-glance)
2. [Where things live](#2-where-things-live)
3. [Runtime components](#3-runtime-components)
4. [Repository layout](#4-repository-layout)
5. [Frontend architecture](#5-frontend-architecture)
6. [Data model](#6-data-model)
7. [Key flows](#7-key-flows)
8. [Sync and conflict rules](#8-sync-and-conflict-rules)
9. [Configuration, build and deploy](#9-configuration-build-and-deploy)
10. [Trust boundaries and known risks](#10-trust-boundaries-and-known-risks)
11. [Where to change what](#11-where-to-change-what)

---

## 1. System at a glance

There is no application server of our own. The app is static files plus one small serverless function, and it talks directly to Supabase for accounts and sync.

```
 USER'S DEVICE
 +--------------------------------------------------------------+
 |  Browser tab: React single-page app                          |
 |    pages / components / contexts / lib                       |
 |                                                              |
 |  Stored on the device                                        |
 |    IndexedDB "folio-db"   books, files, progress, pendingSync|
 |    localStorage           Supabase session, reading hand     |
 |    Service worker         app shell + a few runtime caches   |
 +------+-------------------+------------------+----------------+
        |                   |                  |
        | direct (CORS)     | same origin      | direct (HTTPS)
        |                   |                  | anon key + user JWT
        v                   v                  v
   gutendex.com      /api/fetch-book        Supabase
   (Gutenberg        (Vercel serverless     Auth + Postgres
    catalog)          function)             (collection_items,
                          |                  reading_progress)
                          v
                  archive.org   search, file listings, epub files
                  gutenberg.org epub files

 Cover images are the exception: <img> tags load them straight from
 gutenberg.org and archive.org, not through the function.
```

One more outside host exists, only for reading scanned PDFs: Tesseract's text-recognition engine is fetched from a public CDN (`cdn.jsdelivr.net`) the first time it is needed (section 3.5).

Three things to keep in mind:

- **Books are read from the device, not from the server.** The epub file is stored in the browser's IndexedDB. A book downloaded from Gutenberg or the Internet Archive is never stored in Supabase, another device downloads it again from the source.
- **Supabase holds small records, plus the files of imported books:** which books you saved (metadata), how far you got in each, and a private copy of each imported book's file so it can open on your other devices (section 3.4).
- **The serverless function is only a relay.** It exists to get around CORS and redirects when fetching epubs and Internet Archive data.

---

## 2. Where things live

| Thing | Where it lives | Synced? |
|---|---|---|
| UI code | Browser. Built by Vite into `dist/`, served as static files by Vercel | n/a |
| Epub file of a downloaded book (Gutenberg, Archive) | IndexedDB, store `files` | No, per device (downloaded again from the source) |
| Epub file of an imported book (an epub, or a converted PDF) | IndexedDB, store `files`, **and** a copy in Supabase Storage, bucket `books` | Yes, other devices download it the first time they open the book |
| Book metadata (title, author, cover, source ids) | IndexedDB `books` **and** Supabase `collection_items` | Yes |
| Reading progress | IndexedDB `progress` **and** Supabase `reading_progress` | Yes |
| Changes made offline | IndexedDB `pendingSync` (a queue) | No, flushed when back online |
| A scanned PDF being converted (the PDF and each recognised page) | IndexedDB `pdfJobs` and `ocrPages`, until the book is made | No, per device |
| Sign-in session | `localStorage`, managed by the Supabase client | n/a |
| Reading hand (left/right) | `localStorage` key `folio-handedness` | No, per device |
| Theme, text size and text width in the reader | `localStorage` keys `folio-reader-theme`, `folio-reader-size` and `folio-reader-width` | No, per device |
| Search results | Component state in memory | No |
| Book catalogs | Gutendex (Project Gutenberg) and Internet Archive, external | n/a |
| Server-side code | Only `api/fetch-book.js` | n/a |
| Secrets | None on a server. The Supabase URL and anon key are compiled into the bundle (public by design) | n/a |

---

## 3. Runtime components

### 3.1 Browser app

A React 19 single-page app (React Router 7, Tailwind 3, lucide icons), bundled by Vite 8. `index.html` loads `src/main.jsx`, which renders `App.jsx`. The reader and its large dependency (epub.js) are split into their own chunks and loaded only when needed.

### 3.2 Storage on the device

**IndexedDB database `folio-db` (version 2)**, wrapped by `src/lib/db.js`:

| Store | Key | Holds |
|---|---|---|
| `books` | `id` | Book metadata object (see section 6) |
| `files` | `bookId` | `{ bookId, blob, savedAt }`, the epub itself |
| `progress` | `bookId` | `{ bookId, location, percentage, updatedAt }` |
| `pendingSync` | auto-increment `id` | Queued operations: `add_book`, `remove_book`, `progress` |
| `pdfJobs` | `id` | A scanned PDF being converted: `{ id, fileName, language, pageCount, blob (the PDF), createdAt }`. Removed when the book is made (added in version 2) |
| `ocrPages` | `[jobId, page]` | One recognised page: `{ jobId, page, lines, figures }` (added in version 2) |

The database name is fixed and records are not scoped to a user (see section 10).

**localStorage:** the Supabase auth session (key of the form `sb-<project-ref>-auth-token`) `folio-handedness`, `folio-reader-theme`, `folio-reader-size`, `folio-reader-width`, and `folio-cloud-toolarge:<user id>` (imported books too big to copy to the account, so they are not retried on every start).

**Service worker** (generated by `vite-plugin-pwa` with Workbox, `registerType: 'prompt'`):
- Precaches the built app files, so the app shell opens offline.
- **Updates.** The precache is served first, so an installed app keeps opening the version it already has until a newer service worker takes over. In `prompt` mode a new version is downloaded in the background and then waits. `src/components/UpdatePrompt.jsx` asks the server for a newer version every 30 minutes and each time the app comes back to the foreground, and when one is waiting it shows "A new version of Folio is ready" with **Reload** and **Later**. Nothing reloads by itself, so a book, an import or an OCR run is never interrupted, and the banner is held back while the reader is open. The Account page shows the commit and time of the running build (`VITE_BUILD_COMMIT`, from `VERCEL_GIT_COMMIT_SHA`), which is the quickest way to see whether a device has the latest deploy. A device still on a version from before this banner existed needs to be closed and opened a couple of times once to receive it.
- Runtime rules: `gutendex.com` is `NetworkFirst` (cache `gutendex-cache`, up to 100 entries, 1 day) and `www.gutenberg.org` is `CacheFirst` (cache `book-content-cache`, up to 50 entries, 30 days).
- PDF import code is not part of the install download. The pdf.js chunk, its worker and the converter are cached the first time a PDF is imported (cache `pdf-import-cache`), and Tesseract's engine files from the CDN are cached the same way (`ocr-engine-cache`). Offline use of these caches has not been tested in a real browser.
- There is no rule for Google Fonts, so offline the app falls back to Georgia and system fonts.
- Book *content* does not depend on these caches. Offline reading works because the epub is in IndexedDB.

### 3.3 Vercel

Vercel hosts the static build and runs one function.

**`api/fetch-book.js`** (`GET /api/fetch-book?url=<absolute url>`): fetches the given URL server-side (following redirects), buffers the whole body, and returns it with the original `Content-Type` and `Access-Control-Allow-Origin: *`. It is the only server-side code in the project. It has no host allowlist, size limit or authentication (see section 10).

It is used for:
- epub downloads from both sources (`fetchBookContent` in `src/lib/gutendex.js`),
- every Internet Archive API call (search and per-item file listings) in `src/lib/archive.js`.

**`vercel.json`** has three rewrites: `/api/gutenberg/*` and `/api/archive/*` (proxies to those sites, currently unused by any code), and a catch-all to `/index.html` so client-side routes work on refresh.

### 3.4 Supabase

Supabase provides accounts and the two sync tables. The browser talks to it directly with the public anon key and the signed-in user's token. Row level security is the only access control, and there is no server code of ours in between.

- **Auth:** email and password (sign-up needs email confirmation, per the Login screen), plus Google OAuth. The client persists the session and refreshes the token automatically.
- **Tables** (`supabase-schema.sql`, run by hand in the SQL editor):
  - `collection_items`: `user_id`, `book_id`, `title`, `author`, `cover`, `source`, `source_id`, `epub_url`, `text_url`, `created_at`. Unique on `(user_id, book_id)`.
  - `reading_progress`: `user_id`, `book_id`, `location`, `percentage`, `updated_at`. Unique on `(user_id, book_id)`.
  - Each table has one policy: `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`, plus an index on `user_id`. Rows are deleted with the user (`on delete cascade`).
- **Storage** (`supabase-storage.sql`, run by hand): a private bucket `books` that accepts only `application/epub+zip`, up to 50 MB per file. Files are at `<user id>/<book id>.epub`. Four policies (read, add, replace, delete) allow a signed-in user to touch only the folder named with their own user id. On the free plan, storage is 1 GB in total and 50 MB per file (check Supabase's pricing page for current figures). Nothing in the app needs a database column for this: which books have a stored copy is found by listing the user's folder.

### 3.5 External catalogs

| Source | How the app reaches it | What it provides |
|---|---|---|
| Gutendex (`gutendex.com/books`), an API over Project Gutenberg | Browser calls it directly | Search, topics, popular, by id; epub and text URLs; covers |
| Internet Archive (`advancedsearch.php`, `/metadata/<id>`, `/download/...`) | Through `/api/fetch-book` | Search results, file listings, epub files |
| Google Books (`googleapis.com/books/v1/volumes`), free epubs only | Browser calls it directly, no API key; the epub is downloaded through `/api/fetch-book` | Search by text or subject, one book by id, an epub download link, covers |
| Internet Archive covers (`/services/img/<id>`), Gutenberg covers | Straight from `<img>` tags | Cover images |
| `cdn.jsdelivr.net` (Tesseract.js worker script, engine and per-language data) | Browser, only when a scanned PDF is converted | Text recognition. English data is about 3 MB, kept in IndexedDB by Tesseract after the first download |

---

## 4. Repository layout

About 4,300 lines of JavaScript and JSX across 28 files.

```
api/
  fetch-book.js           Vercel function: server-side fetch relay
src/
  main.jsx                Entry point, mounts <App/>
  App.jsx                 Provider tree, routes, route guards
  index.css               Tailwind layers, font import, helper classes, custom scrollbar (laptops and desktops only)
  lib/
    supabase.js           Supabase client (reads VITE_ env vars)
    db.js                 IndexedDB wrapper (books, files, progress, pendingSync)
    gutendex.js           Gutendex client, book mapping, fetchBookContent()
    archive.js            Internet Archive client, lazy epub lookup, vetting of results
    googlebooks.js        Google Books client (free epubs only), vetting of results
    importEpub.js         Reads a local .epub file into a book + stored file
    cloudFiles.js         Upload, download, list and delete a book's file in Supabase Storage
    recency.js            Library and shelf order: most recently added or read first
    readerPrefs.js        Saves and checks the reader's theme, text size, text width and reading hand on this device
    importPdf.js          Opens a PDF, converts it to an epub, hands it to importEpub
    pdf/                  PDF to epub conversion (section 5.8), loaded only when a PDF is imported
      layout.js           Pure logic: text positions -> paragraphs, headings, chapters
      convert.js          Per-page flow: text, OCR or plate; figures; builds the epub
      render.js           Canvas helpers, finds pictures in PDFs and on scans
      ocr.js              Tesseract.js wrapper and the language list
      epub.js             Builds an EPUB 3 file with JSZip
  contexts/
    AuthContext.jsx       Current user, sign in/up/out, Google sign-in
    LibraryContext.jsx    Collection, progress, online state, all sync logic
  components/
    NavShell.jsx          Desktop sidebar and mobile bottom nav
    BookCard.jsx          Cover tile used in every grid
    ImportEpubButton.jsx  File picker for .epub and .pdf, results, resume of stopped scans
    UpdatePrompt.jsx      "New version ready" banner and the periodic check for updates
    PdfImportDialog.jsx   Dialog for one PDF: analysis, scan question, progress, cancel
  pages/
    Landing.jsx           Public marketing page (signed-out root)
    Login.jsx             Sign in / create account / Google
    Home.jsx              "Your shelf": currently reading + collection (most recent first)
    Discover.jsx          Search, topics, merged results from both sources
    Collection.jsx        Library, most recently added or read first, with local search and import button
    BookDetail.jsx        One book: add, read, download for offline
    Reader.jsx            The reading view
    Account.jsx           Account info, connection state, sign out
public/                   Favicon and PWA icons
supabase-schema.sql       Tables, row level security, indexes (run by hand)
supabase-storage.sql      Private storage bucket and per-user rules for imported books (run by hand, optional)
vercel.json               Rewrites
vite.config.js            Vite, React plugin, PWA manifest and cache rules
tailwind.config.js        Design tokens (colors, fonts)
eslint.config.js          Lint rules
```

---

## 5. Frontend architecture

### 5.1 Provider tree

```
<BrowserRouter>
  <AuthProvider>           user, loading, auth actions
    <LibraryProvider>      collection, progressMap, sync (needs the user)
      <AppRoutes/>
```

### 5.2 Routes

| Path | Guard | Layout | Component |
|---|---|---|---|
| `/` | `RootRoute`: signed out sees `Landing`, signed in sees `Home` | `NavShell` when signed in | `Landing` / `Home` |
| `/login` | none | none | `Login` |
| `/discover` | `ProtectedRoute` | `NavShell` | `Discover` |
| `/collection` | `ProtectedRoute` | `NavShell` | `Collection` |
| `/account` | `ProtectedRoute` | `NavShell` | `Account` |
| `/book/:id` | `ProtectedRoute` | `NavShell` | `BookDetail` |
| `/read/:id` | `ProtectedRoute` | none (full screen), lazy-loaded | `Reader` |

`ProtectedRoute` waits for the auth check to finish, then redirects to `/login` if there is no user.

### 5.3 Book ids and source dispatch

Every book has a string id whose prefix says where it came from. `BookDetail` and `Reader` branch on it.

| Id | Source | File comes from |
|---|---|---|
| `gutenberg-<number>` | Project Gutenberg via Gutendex | Proxy download from gutenberg.org |
| `google-<volume id>` | Google Books (free epub) | Proxy download from the link Google gives, fetched and checked before the book is added |
| `archive-<identifier>` | Internet Archive | Proxy download from archive.org, epub URL looked up lazily |
| `import-<32 hex chars>` | A file the user imported: an epub, or a PDF converted to an epub (the hash is of the PDF) | Copied to the user's account when imported, so any device can download it on first open |

### 5.4 The two contexts

- **`AuthContext`** exposes `user`, `loading`, `isAuthenticated`, and `signInWithEmail`, `signUpWithEmail`, `signInWithGoogle`, `signOut`. It subscribes to Supabase auth changes.
- **`LibraryContext`** is the center of the app's data handling. It exposes `collection`, `progressMap`, `isOnline`, `syncing`, `addToCollection`, `removeFromCollection`, `saveProgress`, `getProgress`, `isInCollection`. Every write goes to IndexedDB first, then to Supabase if possible, otherwise into the `pendingSync` queue. It also runs the reconcile and flush logic (section 8).

### 5.5 The reader

`Reader.jsx` uses epub.js only as a parser. It does not use epub.js's own rendering.

1. Load the epub blob from IndexedDB. If absent, download it through the proxy, then store it.
2. Parse it with `ePub(arrayBuffer)`.
3. For each chapter (spine item), read the chapter's source, render it to an HTML string, resolve its images to blob URLs, and strip `<script>` tags. The source is parsed as XML first and as HTML only if it is not well-formed XML. This matters because epub.js picks its parser from the file extension and reads `.html` files as HTML, which mangles XHTML self-closing tags: an empty `<i/>` becomes "start italics, never stop", and the rest of the chapter comes out italic. Many Calibre-made epubs put XHTML in `.html` files.
4. Insert chapters into one natively scrolling `div` with `dangerouslySetInnerHTML`. Chapters load lazily: the next one is added when the reader is within about one and a half screens of the bottom. Each chapter is a memoised `Chapter` component, so a re-render of the reader (progress updating while scrolling, a setting changing) leaves its HTML alone. Without that, React set every chapter's `innerHTML` again on each of those re-renders, which reparsed the chapters while reading and removed the paragraph a scroll position was anchored to.
5. After scrolling stops (150 ms debounce, plus on touch end), work out which chapter is at the top and how far into it, and save that.
6. On open, load chapters up to the saved one, scroll to the saved chapter and position, and keep re-applying that position while images load, until the reader scrolls or 5 seconds pass.

Display options are remembered on the device (`src/lib/readerPrefs.js`): theme (light, sepia, dark), text size (14 to 28 px), text width and reading hand. Stored values are checked on load and fall back to the defaults if they are unknown or out of range.

**Text width** (Narrow 700 px, Medium 900 px, Wide 1100 px, Full) sets how wide the column of text may be. The default is Medium. It applies **only on a computer**: the rule sits inside `@media (hover: hover) and (pointer: fine)`, and the control is hidden elsewhere, so a phone or a touch tablet always gets the column it had before (up to 700 px).

**Keeping your place when the layout changes.** Changing the text size or width reflows the chapters, which would otherwise leave the same scroll offset pointing somewhere else in the book. Before the change the reader notes the innermost block (paragraph, heading, list item, picture) at the top edge and how far into it the edge is, and after the new layout is in place (`useLayoutEffect`) scrolls so that same spot is at the top again. It falls back to the chapter fraction if a chapter has no such blocks. This relies on the chapter elements staying in the page, which is why chapters are memoised.

### 5.6 Discover

- The current search or topic lives in the URL (`?q=` or `?topic=`), so refresh, links and back work.
- Gutendex is always searched. The Internet Archive is searched only if the user ticks "Also search the Internet Archive" under the topics (off by default, remembered in `localStorage` under `folio-include-archive`), because its books are scans uploaded by libraries and the public and are not checked for quality. When both are on they are queried in parallel, each source's results appear as soon as that source answers (Gutendex results are listed first, and a spinner shows while the Archive is pending), and a failed source simply contributes nothing.
- Each fetch gets a request id, and responses from an older search are dropped.
- Archive results are not checked for an epub at search time. The check happens when a book page opens (`BookDetail`) or the book is read.
- Google Books is a third source, also off unless ticked ("Also search Google Books (free ebooks)", `localStorage` key `folio-include-google`). It needs something to search for, so it adds results for a text search or a topic but not to the plain popular view. Only books Google offers as a free, fully viewable epub in English, with an author and a book-like title, are shown. Opening one downloads the epub first and checks it really is an epub (a zip, starting with "PK"). If Google answers with a sign-in page or refuses, the book is not added to the library and the user is told.
- Archive results are vetted on the client, from each item's own metadata (`isReputable` in `src/lib/archive.js`): every listed language must be English, the title must be in Latin script, must not read as another language, a file name, a catalogue, report or magazine, the item must have an author, must not be in a public-upload or periodical collection, and must have at least 100 downloads. This is a filter and not a guarantee, since the Archive does not review uploads and the language, title and author are typed in by whoever uploaded the item. Looking up one known book by id (opening a book already in the library) is not vetted.

### 5.7 Styling

Tailwind 3 cannot make "current text colour at N% opacity" classes, so `bg-current/5`, `/10` and `/15` (used by the reader's controls) are written out by hand in `src/index.css` with `color-mix`. Without them those classes produce no CSS and the reader's selected option, slider track and hover circles are invisible.

Tailwind with custom tokens in `tailwind.config.js`: `parchment`, `ink`, `ink-muted`, a teal scale, and three font families (Playfair Display for headings, Inter for UI, Lora for reading), loaded from Google Fonts by a CSS `@import`.

### 5.8 PDF import

A PDF is converted to an epub on the device, nothing is uploaded. The epub then goes through the normal epub import (section 7), so it is stored, read, resumed and synced like any other imported book. All of the conversion code is in `src/lib/pdf/` and is loaded only when a PDF is imported.

**Per page**, the converter decides:

| The page has | What happens |
|---|---|
| 20 or more characters of text | The text is used as it is. No recognition needed. |
| Almost no text, and the PDF is mostly like this (3 or more such pages, or half) | A scan. The page is drawn at about 200 dpi and read with Tesseract.js (text recognition). |
| Almost no text, but only a few such pages in a normal book | A plate. Kept as an image. |

**Cleaning up** (`layout.js`, pure logic with no browser dependencies, tested on its own):
- Items on a page are grouped into lines. A page set in two columns is detected from a vertical gap and read left column, then right, with a full-width title kept in place.
- Page numbers and text repeated at the top or bottom of many pages (running headers) are removed.
- Lines are joined into paragraphs using extra spacing, indents, or a short last line (the last only for books that do not use indents). Words split by a hyphen at a line end are rejoined.
- Larger text becomes headings. A paragraph that continues over a page or column break is merged back together.
- Chapters come from the PDF's bookmarks, else from big headings, else from runs of 10 pages. A chapter over 40 pages is cut into parts, since the Reader loads and tracks progress one chapter at a time.

**Pictures:** in a text PDF, images are found by walking the page's drawing commands, cut out of a rendering of the page, and placed between paragraphs by position. Tesseract does not report where pictures are on a scan, so there they are found as tall, non-blank gaps between the recognised lines.

**Scans take time**, so they are built to survive interruption. Each finished page is saved in `ocrPages`, and the PDF itself is kept in `pdfJobs`. If the user presses Stop, closes the tab or the phone sleeps, the job is still there and resumes from the unfinished pages. The dialog keeps the screen awake while it works (where the browser allows it). A job is deleted once the book is made.

**Languages for recognition:** English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Arabic, Urdu and Hindi. Arabic and Urdu put `dir="rtl"` on every element (the Reader keeps only the body of each chapter, so a setting on the page itself would be lost). The choice is remembered in `localStorage` under `folio-ocr-language`.

**Other devices:** the converted epub is what is copied to the account (section 7), so a second device downloads the finished book and never has to read a scan again.

**Identity:** the book id is `import-` plus a hash of the PDF, so the same PDF imported on a second device shares progress. If the two conversions split chapters differently, positions can be a little off.

---

## 6. Data model

### 6.1 Book object (in memory and in `books`)

```
{
  id,                // see section 5.3
  source,            // 'gutenberg' | 'archive' | 'import'
  sourceId,          // Gutenberg number, Archive identifier, or file hash
  title, author, authors[],
  cover,             // URL, or a small JPEG data URL for imported books
  subjects[], languages[], downloadCount,
  epubUrl, textUrl,  // null until resolved (Archive) and always null for imports
  needsEpubResolution,   // true for unresolved Archive results
  addedAt            // number locally, ISO string when pulled from Supabase
}
```

Only these fields reach Supabase: `id` as `book_id`, `title`, `author`, `cover`, `source`, `sourceId` as `source_id`, `epubUrl` as `epub_url`, `textUrl` as `text_url`. Subjects, languages and download count are not synced. `addedAt` is not sent, and on pull it is filled from the row's `created_at`. Because `addedAt` can be a number or an ISO string, ordering goes through `toMillis` in `src/lib/recency.js`: a book's "last touched" time is the later of `addedAt` and the time it was last read, and the Library and Home list the newest first (ties by title).

### 6.2 Reading progress

```
{ bookId, location, percentage, updatedAt }
location   = JSON string: { sectionIndex, fraction }
             sectionIndex = chapter number (0-based spine position)
             fraction     = how far down that chapter, 0 to 1
percentage = round((sectionIndex + fraction) / numberOfChapters * 100)
```

Progress saved by older versions has no `fraction`. The reader works the position back out from the chapter and the percentage.

Note that the percentage counts every chapter equally, whatever its length or whether it is front matter. Its accuracy as a measure of "how much of the book" has not been verified.

### 6.3 Offline queue entries

```
{ type: 'add_book',    book }
{ type: 'remove_book', bookId }
{ type: 'progress',    bookId, location, percentage, updatedAt }
```

---

## 7. Key flows

**Search**
`Discover` -> `gutendex.js` (direct to gutendex.com) and `archive.js` (through `/api/fetch-book` to archive.org) -> mapped into the book object -> shown per source as it arrives.

**Open a book page**
`BookDetail` looks in the local collection first (works offline). If absent, it fetches the book from the source by id prefix. For an Archive book with no epub URL yet, it looks up the file listing in the background and, if there is no epub, disables the buttons and says so.

**Add to library**
`addToCollection` -> IndexedDB `books` -> state -> Supabase `collection_items` upsert if online and signed in, else a `pendingSync` entry.

**Download for offline**
`BookDetail` -> `fetchBookContent` -> `/api/fetch-book?url=...` -> blob -> IndexedDB `files`, and the book is added to the library if it was not already.

**Read**
`Reader` -> epub blob (IndexedDB, or download then store) -> parse and render (section 5.5) -> `saveProgress` on scroll.

**Import an epub**
`ImportEpubButton` -> `importEpub.js`:
1. Reject non-`.epub` names and files that are not zip archives.
2. Parse with epub.js (with a 30 second guard against hangs), read title, author and cover.
3. Reject Adobe-DRM files (presence of `META-INF/rights.xml`).
4. Downscale the cover to a small JPEG data URL (it travels in the synced metadata).
5. Compute the id as `import-` plus the first 32 hex characters of the file's SHA-256, store the blob in `files`, and add the metadata through `addToCollection` (so it syncs).

The id depends only on the file contents, so importing the same file on another device gives the same id and the two devices share progress.

**Copy an imported book to the account, and open it elsewhere**
1. When an imported book is added, `LibraryContext` uploads its file from IndexedDB to `books/<user id>/<book id>.epub`. If the device is offline or the upload fails, an `upload_file` entry is queued (the file is read from IndexedDB again when it is sent) and retried when the connection returns.
2. A file over 50 MB is not uploaded. The book stays on that device only, its page says so, and the id is remembered in `localStorage` so it is not retried on every start.
3. On every start (online), the app lists the user's folder. Books it has a local file for that the account lacks, including ones imported before this feature existed, are uploaded. Books the account has are marked as saved.
4. On another device the book is already in the library (metadata sync). When it is opened, the Reader sees there is no local file and downloads it from the account, keeps it in IndexedDB, and reads. The book page also has a "Download to this device" button.
5. Removing a book from the library deletes the stored copy too (queued if offline).
6. If the file is on neither the device nor the account, or the device is offline, the Reader says which, and what to do.

**Import a PDF**
`ImportEpubButton` -> `PdfImportDialog` -> `importPdf.js` -> `pdf/convert.js`:
1. Check it is a PDF and not password protected, then read the text of every page to see which are scans.
2. If it is mostly scans, ask the user to confirm and choose a language (with a time estimate). A normal PDF converts straight away.
3. Convert page by page (section 5.8) with a progress bar and a Stop button, saving each recognised page.
4. Build an epub, then run it through `importEpubFile` (above) with the id taken from the PDF's bytes. Delete the saved job.

**Resume reading**
`Reader` reads progress from the library state, falling back to IndexedDB, then restores position as described in section 5.5.

---

## 8. Sync and conflict rules

All of this is in `LibraryContext.jsx`.

**When it runs**
- On load, and whenever the signed-in user changes: read IndexedDB into state immediately (fast, works offline), then, if online and signed in, `reconcileWithRemote`.
- When the tab becomes visible or the window regains focus: reconcile again, at most once every 15 seconds.
- When the connection returns: flush the `pendingSync` queue.

**Merge rules**
- **Collection:** the union of local and remote. Remote wins on metadata for a book that exists in both. A local book that is missing from the remote list is treated as removed on another device and is deleted locally (including its stored file), unless a pending `add_book` is protecting it.
- **Progress:** last write wins, comparing `updated_at` from Supabase with the local `updatedAt`.

**Imported files** follow the same local-first idea: the file is saved on the device first, then copied to the account when possible (see the flow in section 7). They are not merged or compared, a stored copy is simply replaced when the same book is added again.

**Flushing:** each queued entry is replayed (upserts for adds and progress, a delete for removals, an upload for `upload_file`). An entry that fails stays queued and is retried next time.

---

## 9. Configuration, build and deploy

**Environment variables** (compiled into the bundle at build time):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

If they are missing, `supabase.js` falls back to placeholder values, so the app starts but every network call to Supabase fails. The README mentions a `.env.example` that is not in the repository.

**Scripts:** `npm run dev` (Vite dev server), `npm run build`, `npm run preview`, `npm run lint`.

**Local development caveat:** `npm run dev` serves only the front end. `/api/fetch-book` does not exist there, so downloads and Internet Archive features fail unless you run through the Vercel CLI (`vercel dev`) or add a proxy to the Vite config.

**Deploy:** import the repo into Vercel and set the two environment variables. Vercel serves `dist/` and deploys `api/fetch-book.js` as a function. Installing to the home screen from the deployed URL is what enables the offline app shell.

**PWA:** name "Folio", theme color `#2D6A5E`, standalone display, portrait, icons at 192 and 512 px.

**Database setup:** run `supabase-schema.sql` once in the Supabase SQL editor. Run `supabase-storage.sql` too if you want imported books to open on all your devices. Without it everything else works, imported books just stay on one device, and uploads fail quietly. It is not a migration system, and the `create policy` statements are not safe to run twice.

**Quality tooling:** ESLint is configured and currently reports 15 problems that predate recent changes. There are no automated tests and no CI.

---

## 10. Trust boundaries and known risks

These come from reading the code. They have not been exploited or load-tested.

1. **The relay function is an open proxy.** `api/fetch-book.js` fetches any URL a caller supplies and allows any origin to read the response. Anyone can use it to fetch arbitrary sites through your Vercel account, with no size limit. It should be restricted to the hosts it needs (`archive.org`, `gutenberg.org`, and their redirect targets) and capped in size.

2. **Book HTML is inserted into the page with only `<script>` tags removed.** The Reader renders chapter HTML from third parties (Internet Archive items are uploaded by the public) and from imported files. Event-handler attributes such as `onerror=` and `javascript:` links are not removed, and `<script>` stripping alone does not make `innerHTML` safe. Code running there would run in the app's origin and could read the Supabase session in `localStorage`. A sanitizer (for example DOMPurify) and a Content Security Policy would close this.

3. **Local data is not scoped per user.** IndexedDB uses one fixed database name, and signing out clears nothing. On a shared device, a second account would see the first account's local books until a sync removes them, and their stored files are kept.

4. **Function response size.** The function buffers the whole file in memory and returns it. Vercel limits function response bodies (4.5 MB at last check, not verified here), which a large illustrated epub could exceed.

5. **Sync edge cases.** An offline removal can be undone: the book is still on the server, so the next reconcile re-adds it before the queued delete is sent.

6. **Imported books need the storage setup to follow you.** Without `supabase-storage.sql` they stay on the device that imported them. With it, files over 50 MB (the free-plan cap) are not copied, and the free plan has 1 GB of storage in total.

7. **Archive quality cannot be guaranteed.** The Archive does not review uploads, its language field is whatever the uploader typed, and the epubs it makes are produced from page scans by text recognition, so they can contain scanning errors. The vetting in section 5.6 uses only the metadata it is given and has not been checked against live Archive results (archive.org could not be reached from the build environment), so its thresholds are reasoned, not tuned. Gutenberg books are proofread transcriptions and do not have this problem.
8. **Google Books downloads are untested against the live service.** The API documents an epub download link for free books, and a separate token link, and it is not known whether the plain link works without signing in. The code handles both outcomes (a refused or sign-in answer leaves the book out of the library with a clear message), but it was only tested with stand-ins for Google. Google may also rate-limit searches made without an API key. Like the Archive, its free books are mostly scans, so quality can vary.
9. **PDF conversion is heuristic.** It was tested on generated PDFs with known text (digital PDFs came out paragraph for paragraph exact) and on a clean generated scan (no word errors), but not on a wide range of real files. Known weak spots: figures on multi-column scans are not found, figures drawn as vector graphics are not found, tables, footnotes and equations come out as ordinary paragraphs, bold and italic are not kept, books with no indents and no spacing between paragraphs can have paragraphs merged, and right-to-left PDFs with a text layer were not tried on real files. Large scans are slow, slower on a phone, and the screen has to stay on.
10. **Text recognition depends on a public CDN** for its engine files the first time it is used. Offline use afterwards relies on caching that has not been tested in a real browser.
11. **Housekeeping.** The `/api/gutenberg` and `/api/archive` rewrites are unused. The README still describes an epub.js rendition and does not mention the Internet Archive or importing. Progress percentage accuracy is unverified (section 6.2).

---

## 11. Where to change what

| To change | Edit |
|---|---|
| Add another book source | New module in `src/lib/` that returns the book object shape; add it to the fetchers in `Discover.jsx`; add its id prefix to the lookups in `BookDetail.jsx`; add its file-fetch fallback in `Reader.jsx` |
| Sync behavior or conflict rules | `src/contexts/LibraryContext.jsx` |
| Local storage layout | `src/lib/db.js` (bump `DB_VERSION` and add an upgrade step) |
| What is stored in Supabase | `supabase-schema.sql`, plus the two `collection_items` upserts (adding a book and flushing the queue) and the reconcile mapping in `LibraryContext.jsx` |
| Reading view, progress and resume | `src/pages/Reader.jsx` |
| Copying imported books to the account, and fetching them on another device | `src/lib/cloudFiles.js`, the file sync in `src/contexts/LibraryContext.jsx`, `src/pages/Reader.jsx` and `src/pages/BookDetail.jsx` |
| Library and shelf ordering (most recently added or read first) | `src/lib/recency.js`, used by `Collection.jsx` and `Home.jsx` |
| Update banner, build stamp | `src/components/UpdatePrompt.jsx`, `registerType` and `define` in `vite.config.js`, `Account.jsx` |
| Importing epub files | `src/lib/importEpub.js` and `src/components/ImportEpubButton.jsx` |
| Google Books source | `src/lib/googlebooks.js`, and the download-first step in `src/pages/BookDetail.jsx` |
| PDF import: paragraph rules, chapters | `src/lib/pdf/layout.js` |
| PDF import: per-page flow, figures, scans | `src/lib/pdf/convert.js`, `render.js`, `ocr.js` |
| PDF import: the dialog and resuming | `src/components/PdfImportDialog.jsx`, `src/lib/importPdf.js` |
| Server relay behavior | `api/fetch-book.js` |
| Offline caching and the PWA manifest | `vite.config.js` |
| Colors, fonts | `tailwind.config.js` and `src/index.css` |
| Reader settings (theme, text size, text width, reading hand): saving, loading and checking stored values | `src/lib/readerPrefs.js`, used by `src/pages/Reader.jsx` |
| Text width options and the keep-your-place logic in the reader | `WIDTH_PX`, `readBlockAnchor` and `keepPlace` in `src/pages/Reader.jsx` |
| Scrollbar look (slim, no arrows; the reader tints it per theme through `--scroll-thumb`) | `src/index.css`, and the reading surface in `src/pages/Reader.jsx` |
| Routes and guards | `src/App.jsx` |
