import { createClient } from '@supabase/supabase-js'

// Replace these with your actual Supabase credentials from supabase.com
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key'

// Writes of reading progress are small, so they are sent with keepalive: the
// browser then finishes sending them even if the page is hidden or closed a
// moment later (switching apps, locking the phone, closing the tab), which is
// exactly when the last position of a reading session is saved. If a browser
// refuses the option, the same request is sent the ordinary way.
const isProgressWrite = (url, init) =>
  /\/rest\/v1\/reading_progress/.test(url) && init && init.method && init.method !== 'GET' && init.method !== 'HEAD'

function fetchWithKeepalive(input, init) {
  const url = typeof input === 'string' ? input : input && input.url
  if (!isProgressWrite(url || '', init)) return fetch(input, init)
  return fetch(input, { ...init, keepalive: true }).catch((err) => {
    if (err instanceof TypeError && !(init && init.signal && init.signal.aborted)) return fetch(input, init)
    throw err
  })
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: { fetch: fetchWithKeepalive },
})
