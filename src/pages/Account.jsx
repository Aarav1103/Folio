import { useAuth } from '../contexts/AuthContext'
import { useLibrary } from '../contexts/LibraryContext'
import { useNavigate } from 'react-router-dom'
import { LogOut, Wifi, WifiOff } from 'lucide-react'

export default function Account() {
  const { user, signOut } = useAuth()
  const { isOnline, collection, syncing } = useLibrary()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="px-6 md:px-10 py-8 max-w-md mx-auto">
      <h1 className="font-display text-3xl text-ink mb-8">Account</h1>

      <div className="bg-white rounded-xl border border-ink/10 p-5 mb-6">
        <p className="text-xs text-ink-muted uppercase tracking-wide mb-1">Signed in as</p>
        <p className="text-sm font-medium text-ink">{user?.email}</p>
      </div>

      <div className="bg-white rounded-xl border border-ink/10 p-5 mb-6 flex items-center gap-3">
        {isOnline ? <Wifi size={18} className="text-teal-600" /> : <WifiOff size={18} className="text-ink-muted" />}
        <div>
          <p className="text-sm font-medium text-ink">{isOnline ? 'Connected' : 'Offline'}</p>
          <p className="text-xs text-ink-muted">
            {syncing ? 'Syncing your library...' : isOnline ? 'Your progress syncs automatically' : 'Changes will sync once you reconnect'}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-ink/10 p-5 mb-6">
        <p className="text-sm font-medium text-ink">{collection.length} books in your library</p>
      </div>

      <p className="text-xs text-ink-muted mb-6">
        Version {import.meta.env.VITE_BUILD_COMMIT}, built {new Date(import.meta.env.VITE_BUILD_TIME).toLocaleString()}
      </p>

      <button
        onClick={handleSignOut}
        className="flex items-center gap-2 text-sm font-medium text-red-600 px-4 py-2.5 rounded-lg hover:bg-red-50 transition-colors"
      >
        <LogOut size={16} />
        Sign out
      </button>
    </div>
  )
}
