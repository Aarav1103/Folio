import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { LibraryProvider } from './contexts/LibraryContext'
import NavShell from './components/NavShell'
import UpdatePrompt from './components/UpdatePrompt'

import Login from './pages/Login'
import Landing from './pages/Landing'
import Home from './pages/Home'
import Discover from './pages/Discover'
import Collection from './pages/Collection'
import Account from './pages/Account'
import BookDetail from './pages/BookDetail'
// Reader pulls in epub.js, a sizeable library, so it's loaded only when needed
const Reader = lazy(() => import('./pages/Reader'))

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-ink-muted text-sm">Loading...</p>
      </div>
    )
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />
  return children
}

// The root path shows the public landing page to a visitor who isn't
// signed in yet, and the actual app to one who is, rather than
// bouncing everyone straight to a login form before they know what
// they're signing up for.
function RootRoute() {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-ink-muted text-sm">Loading...</p>
      </div>
    )
  }

  if (!isAuthenticated) return <Landing />
  return (
    <NavShell>
      <Home />
    </NavShell>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RootRoute />} />

      <Route
        path="/read/:id"
        element={
          <ProtectedRoute>
            <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-ink-muted text-sm">Loading reader...</div>}>
              <Reader />
            </Suspense>
          </ProtectedRoute>
        }
      />

      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <NavShell>
              <Routes>
                <Route path="/discover" element={<Discover />} />
                <Route path="/collection" element={<Collection />} />
                <Route path="/account" element={<Account />} />
                <Route path="/book/:id" element={<BookDetail />} />
              </Routes>
            </NavShell>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <LibraryProvider>
          <AppRoutes />
          <UpdatePrompt />
        </LibraryProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
