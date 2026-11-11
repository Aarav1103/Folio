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

Three things to keep in mind:

- **Books are read from the device, not from the server.** The epub file is stored in the browser's IndexedDB. Supabase never holds book files.
- **Supabase holds only small records:** which books you saved (metadata) and how far you got in each.
- **The serverless function is only a relay.** It exists to get around CORS and redirects when fetching epubs and Internet Archive data.

---

## 2. Where things live

| Thing | Where it lives | Synced? |
|---|---|---|
| UI code | Browser. Built by Vite into `dist/`, served as static files by Vercel | n/a |
| Epub file of a downloaded or imported book | IndexedDB, store `files` | No, per device |
| Book metadata (title, author, cover, source ids) | IndexedDB `books` **and** Supabase `collection_items` | Yes |
| Reading progress | IndexedDB `progress` **and** Supabase `reading_progress` | Yes |
| Changes made offline | IndexedDB `pendingSync` (a queue) | No, flushed when back online |
| Sign-in session | `localStorage`, managed by the Supabase client | n/a |
| Reading hand (left/right) | `localStorage` key `folio-handedness` | No |
| Theme and text size in the reader | React state only, reset on every open | No |
| Search results | Component state in memory | No |
| Book catalogs | Gutendex (Project Gutenberg) and Internet Archive, external | n/a |
| Server-side code | Only `api/fetch-book.js` | n/a |
| Secrets | None on a server. The Supabase URL and anon key are compiled into the bundle (public by design) | n/a |

---

## 3. Runtime components

### 3.1 Browser app

A React 19 single-page app (React Router 7, Tailwind 3, lucide icons), bundled by Vite 8. `index.html` loads `src/main.jsx`, which renders `App.jsx`. The reader and its large dependency (epub.js) are split into their own chunks and loaded only when needed.

### 3.2 Storage on the device

**IndexedDB database `folio-db` (version 1)**, wrapped by `src/lib/db.js`:

| Store | Key | Holds |
|---|---|---|
| `books` | `id` | Book metadata object (see section 6) |
| `files` | `bookId` | `{ bookId, blob, savedAt }`, the epub itself |
| `progress` | `bookId` | `{ bookId, location, percentage, updatedAt }` |
| `pendingSync` | auto-increment `id` | Queued operations: `add_book`, `remove_book`, `progress` |

The database name is fixed and records are not scoped to a user (see section 10).

**localStorage:** the Supabase auth session (key of the form `sb-<project-ref>-auth-token`) and `folio-handedness`.

**Service worker** (generated by `vite-plugin-pwa` with Workbox, `registerType: 'autoUpdate'`):
- Precaches the built app files, so the app shell opens offline.
- Runtime rules: `gutendex.com` is `NetworkFirst` (cache `gutendex-cache`, up to 100 entries, 1 day) and `www.gutenberg.org` is `CacheFirst` (cache `book-content-cache`, up to 50 entries, 30 days).
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

### 3.5 External catalogs

| Source | How the app reaches it | What it provides |
|---|---|---|
| Gutendex (`gutendex.com/books`), an API over Project Gutenberg | Browser calls it directly | Search, topics, popular, by id; epub and text URLs; covers |
| Internet Archive (`advancedsearch.php`, `/metadata/<id>`, `/download/...`) | Through `/api/fetch-book` | Search results, file listings, epub files |
| Internet Archive covers (`/services/img/<id>`), Gutenberg covers | Straight from `<img>` tags | Cover images |

---

## 4. Repository layout

About 2,700 lines of JavaScript and JSX across 21 files.

```
api/
  fetch-book.js           Vercel function: server-side fetch relay
src/
  main.jsx                Entry point, mounts <App/>
  App.jsx                 Provider tree, routes, route guards
  index.css               Tailwind layers, font import, helper classes
  lib/
    supabase.js           Supabase client (reads VITE_ env vars)
    db.js                 IndexedDB wrapper (books, files, progress, pendingSync)
    gutendex.js           Gutendex client, book mapping, fetchBookContent()
    archive.js            Internet Archive client, lazy epub lookup
    importEpub.js         Reads a local .epub file into a book + stored file
  contexts/
    AuthContext.jsx       Current user, sign in/up/out, Google sign-in
    LibraryContext.jsx    Collection, progress, online state, all sync logic
  components/
    NavShell.jsx          Desktop sidebar and mobile bottom nav
    BookCard.jsx          Cover tile used in every grid
    ImportEpubButton.jsx  File picker + per-file results for importing
  pages/
    Landing.jsx           Public marketing page (signed-out root)
    Login.jsx             Sign in / create account / Google
    Home.jsx              "Your shelf": currently reading + collection
    Discover.jsx          Search, topics, merged results from both sources
    Collection.jsx        Library with local search and import button
    BookDetail.jsx        One book: add, read, download for offline
    Reader.jsx            The reading view
    Account.jsx           Account info, connection state, sign out
public/                   Favicon and PWA icons
supabase-schema.sql       Tables, row level security, indexes (run by hand)
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
| `archive-<identifier>` | Internet Archive | Proxy download from archive.org, epub URL looked up lazily |
| `import-<32 hex chars>` | A file the user imported | Only on the device that imported it |

### 5.4 The two contexts

- **`AuthContext`** exposes `user`, `loading`, `isAuthenticated`, and `signInWithEmail`, `signUpWithEmail`, `signInWithGoogle`, `signOut`. It subscribes to Supabase auth changes.
- **`LibraryContext`** is the center of the app's data handling. It exposes `collection`, `progressMap`, `isOnline`, `syncing`, `addToCollection`, `removeFromCollection`, `saveProgress`, `getProgress`, `isInCollection`. Every write goes to IndexedDB first, then to Supabase if possible, otherwise into the `pendingSync` queue. It also runs the reconcile and flush logic (section 8).

### 5.5 The reader

`Reader.jsx` uses epub.js only as a parser. It does not use epub.js's own rendering.

1. Load the epub blob from IndexedDB. If absent, download it through the proxy, then store it.
2. Parse it with `ePub(arrayBuffer)`.
3. For each chapter (spine item), render it to an HTML string, resolve its images to blob URLs, and strip `<script>` tags.
4. Insert chapters into one natively scrolling `div` with `dangerouslySetInnerHTML`. Chapters load lazily: the next one is added when the reader is within about one and a half screens of the bottom.
5. After scrolling stops (150 ms debounce, plus on touch end), work out which chapter is at the top and how far into it, and save that.
6. On open, load chapters up to the saved one, scroll to the saved chapter and position, and keep re-applying that position while images load, until the reader scrolls or 5 seconds pass.

Display options (theme, text size, left/right hand) are local to the page. Only the reading hand is remembered.

### 5.6 Discover

- The current search or topic lives in the URL (`?q=` or `?topic=`), so refresh, links and back work.
- Gutendex and the Internet Archive are queried in parallel. Each source's results appear as soon as that source answers (Gutendex results are listed first, and a spinner shows while the Archive is pending). A failed source simply contributes nothing.
- Each fetch gets a request id, and responses from an older search are dropped.
- Archive results are not checked for an epub at search time. The check happens when a book page opens (`BookDetail`) or the book is read.

### 5.7 Styling

Tailwind with custom tokens in `tailwind.config.js`: `parchment`, `ink`, `ink-muted`, a teal scale, and three font families (Playfair Display for headings, Inter for UI, Lora for reading), loaded from Google Fonts by a CSS `@import`.

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

Only these fields reach Supabase: `id` as `book_id`, `title`, `author`, `cover`, `source`, `sourceId` as `source_id`, `epubUrl` as `epub_url`, `textUrl` as `text_url`. Subjects, languages and download count are not synced. `addedAt` is not sent, and on pull it is filled from the row's `created_at`.

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

The id depends only on the file contents, so importing the same file on another device gives the same id and the two devices share progress. The file itself stays on each device. Without the file, the reader shows a message asking you to import it on that device.

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

**Flushing:** each queued entry is replayed (upserts for adds and progress, a delete for removals). An entry that fails stays queued and is retried next time.

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

**Database setup:** run `supabase-schema.sql` once in the Supabase SQL editor. It is not a migration system, and the `create policy` statements are not safe to run twice.

**Quality tooling:** ESLint is configured and currently reports 15 problems that predate recent changes. There are no automated tests and no CI.

---

## 10. Trust boundaries and known risks

These come from reading the code. They have not been exploited or load-tested.

1. **The relay function is an open proxy.** `api/fetch-book.js` fetches any URL a caller supplies and allows any origin to read the response. Anyone can use it to fetch arbitrary sites through your Vercel account, with no size limit. It should be restricted to the hosts it needs (`archive.org`, `gutenberg.org`, and their redirect targets) and capped in size.

2. **Book HTML is inserted into the page with only `<script>` tags removed.** The Reader renders chapter HTML from third parties (Internet Archive items are uploaded by the public) and from imported files. Event-handler attributes such as `onerror=` and `javascript:` links are not removed, and `<script>` stripping alone does not make `innerHTML` safe. Code running there would run in the app's origin and could read the Supabase session in `localStorage`. A sanitizer (for example DOMPurify) and a Content Security Policy would close this.

3. **Local data is not scoped per user.** IndexedDB uses one fixed database name, and signing out clears nothing. On a shared device, a second account would see the first account's local books until a sync removes them, and their stored files are kept.

4. **Function response size.** The function buffers the whole file in memory and returns it. Vercel limits function response bodies (4.5 MB at last check, not verified here), which a large illustrated epub could exceed.

5. **Sync edge cases.** An offline removal can be undone: the book is still on the server, so the next reconcile re-adds it before the queued delete is sent. `addedAt` is a number locally and an ISO string after a pull, and `Home` compares them with `>`, so "recently added" ordering is inconsistent.

6. **Imported books are per device.** Metadata syncs, files do not.

7. **Housekeeping.** The `/api/gutenberg` and `/api/archive` rewrites are unused. The README still describes an epub.js rendition and does not mention the Internet Archive or importing. Progress percentage accuracy is unverified (section 6.2).

---

## 11. Where to change what

| To change | Edit |
|---|---|
| Add another book source | New module in `src/lib/` that returns the book object shape; add it to the fetchers in `Discover.jsx`; add its id prefix to the lookups in `BookDetail.jsx`; add its file-fetch fallback in `Reader.jsx` |
| Sync behavior or conflict rules | `src/contexts/LibraryContext.jsx` |
| Local storage layout | `src/lib/db.js` (bump `DB_VERSION` and add an upgrade step) |
| What is stored in Supabase | `supabase-schema.sql`, plus the two `collection_items` upserts (adding a book and flushing the queue) and the reconcile mapping in `LibraryContext.jsx` |
| Reading view, progress and resume | `src/pages/Reader.jsx` |
| Importing files | `src/lib/importEpub.js` and `src/components/ImportEpubButton.jsx` |
| Server relay behavior | `api/fetch-book.js` |
| Offline caching and the PWA manifest | `vite.config.js` |
| Colors, fonts | `tailwind.config.js` and `src/index.css` |
| Routes and guards | `src/App.jsx` |
