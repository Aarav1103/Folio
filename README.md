# Folio

A personal digital library app. Search and read public domain books from Project
Gutenberg, save them to your collection, and pick up exactly where you left off
across devices. Works offline on your phone once a book is downloaded.

## What's already done

- Full reading app built in React (search, library, reading mode with light/dark/sepia themes, font size control)
- Open library search via the free Gutendex API (no signup needed)
- Offline support via a PWA service worker and local IndexedDB storage
- Cross-device sync wired up for Supabase (auth, collection, and progress tables)
- Import your own books as EPUB or PDF files. A PDF is converted to a reflowable book on your device, and scanned PDFs are read with on-device text recognition, so the PDF is never uploaded. Imported books can optionally be copied to your own private Supabase storage so they open on all your devices (see step 2b)

## What you need to do (about 15-20 minutes, no code)

### 1. Create your Supabase project
Go to https://supabase.com, sign up free, and create a new project. Wait
about two minutes for it to finish provisioning.

### 2. Run the database setup
In your Supabase project, open the **SQL Editor** in the left sidebar, click
**New query**, paste in everything from `supabase-schema.sql` (included in
this project), and click **Run**. This creates the two tables Folio needs
and locks them down so each user can only see their own data.

### 2b. Optional: open imported books on all your devices
Imported books (EPUB or PDF files you add yourself) are stored on the device that
imported them. To have them follow you to your other devices, run
`supabase-storage.sql` the same way (SQL Editor, New query, paste, Run). It creates a
private storage bucket that only you can read. Skip it and everything else still works,
imported books just stay on one device.

### 3. Get your API keys
In Supabase, go to **Project Settings -> API**. Copy the **Project URL** and
the **anon public key**.

### 4. Add your keys to the app
Copy `.env.example` to a new file named `.env` in the project root, and paste
your two values in:

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 5. Turn on the sign-in methods you want
In Supabase, go to **Authentication -> Providers**.
- **Email** is on by default, nothing to do.
- **Google**: toggle it on, then follow Supabase's link to create Google
  OAuth credentials (takes about 10 minutes in Google Cloud Console). If you'd
  rather skip this for now, just leave email on and add Google later, the
  code already supports both.

### 6. Run it locally to check everything works
```
npm install
npm run dev
```
Visit the local address it prints, sign up with an email, and try adding a
book.

### 7. Deploy so you can use it on your phone
The easiest path is Vercel:
1. Push this folder to a GitHub repo (or use Vercel's drag-and-drop import).
2. Go to vercel.com, import the repo.
3. Add the same two environment variables (VITE_SUPABASE_URL and
   VITE_SUPABASE_ANON_KEY) in Vercel's project settings.
4. Deploy. You'll get a live URL.
5. Open that URL on your phone's browser and use "Add to Home Screen" to
   install it like a real app (this is what makes offline mode work).

## How the offline + sync system works

- Every action (adding a book, updating progress) writes to your phone or
  laptop's local storage first, so the app never waits on the network.
- If you're online and signed in, that same action is also pushed to
  Supabase immediately.
- If you're offline, the action is queued locally and automatically synced
  the next time you're back online.
- When you open the app on a different device, it pulls your latest
  collection and progress from Supabase and merges it with whatever's
  stored locally, using whichever version was updated more recently.
- Books you tap "Download for offline" on are saved as full files in local
  storage on that specific device, so you can read them with zero signal.
  This part is per-device by design, your phone and laptop each hold their
  own offline copies.

## Project structure

```
src/
  lib/          Supabase client, Gutendex API client, local IndexedDB helpers
  contexts/     Auth state and library/sync state, available app-wide
  components/   BookCard, navigation shell
  pages/        Home, Discover, Collection, BookDetail, Reader, Login, Account
```

## Notes

- All books come from Project Gutenberg via Gutendex, meaning everything in
  Discover is public domain and free to read.
- The reading engine is epub.js, it expects epub-format files. Gutendex
  provides epub links for most catalog entries; a few older entries only
  have plain text, those will show as unavailable to read in-app for now.
