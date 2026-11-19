import { NavLink } from 'react-router-dom'
import { Home, Search, Library, User } from 'lucide-react'

const links = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/discover', label: 'Discover', icon: Search },
  { to: '/collection', label: 'Library', icon: Library },
  { to: '/account', label: 'Account', icon: User },
]

// Three layouts: the bottom bar on a phone held upright, the full sidebar on a wide
// screen, and a slim icon rail on a phone held sideways (the "rail" screen in
// tailwind.config.js), where there is little height to spare for a bar and
// not much width to give to labels.
export default function NavShell({ children }) {
  return (
    // On a phone with a notch, held sideways, the notch is at one end: keep clear of it
    <div
      className="min-h-screen flex"
      style={{ paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      {/* Sidebar (wide screens) / icon rail (phone held sideways) */}
      <aside className="hidden md:flex rail:flex md:flex-col rail:flex-col w-60 rail:w-[4.5rem] border-r border-ink/10 px-6 rail:px-2 py-8 rail:py-4 flex-shrink-0">
        <div className="flex items-center rail:justify-center gap-2 mb-10 rail:mb-4">
          <span className="font-display text-2xl text-teal-600 rail:hidden">Folio</span>
          <span className="font-display text-2xl text-teal-600 hidden rail:inline" aria-hidden="true">F</span>
        </div>
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              title={label}
              className={({ isActive }) =>
                `flex items-center rail:justify-center gap-3 px-3 rail:px-0 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-teal-100 text-teal-600'
                    : 'text-ink-muted hover:bg-ink/5 hover:text-ink'
                }`
              }
            >
              <Icon size={18} strokeWidth={1.75} />
              <span className="rail:hidden">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden rail:hidden flex items-center justify-center py-4 border-b border-ink/10">
          <span className="font-display text-xl text-teal-600">Folio</span>
        </header>

        <main className="flex-1 min-w-0 pb-20 md:pb-0 rail:pb-0">{children}</main>
        {/* Mobile bottom nav */}
        <nav className="md:hidden rail:hidden fixed bottom-0 left-0 right-0 bg-parchment border-t border-ink/10 flex items-center justify-around py-2 px-2">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 px-4 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  isActive ? 'text-teal-600' : 'text-ink-muted'
                }`
              }
            >
              <Icon size={20} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
