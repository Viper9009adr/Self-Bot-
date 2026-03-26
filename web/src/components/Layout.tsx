import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { clearToken } from '../api'

export default function Layout() {
  const navigate = useNavigate()

  function handleLogout() {
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-screen bg-slate-900 text-slate-200">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-800 flex flex-col border-r border-slate-700">
        <div className="px-6 py-5 text-lg font-bold text-green-500 border-b border-slate-700">
          Self-BOT
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-slate-700 text-green-500'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-slate-100'
              }`
            }
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/chat"
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-slate-700 text-green-500'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-slate-100'
              }`
            }
          >
            Chat
          </NavLink>
          <NavLink
            to="/allowlist"
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-slate-700 text-green-500'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-slate-100'
              }`
            }
          >
            Allowlist
          </NavLink>
        </nav>
        <div className="px-3 py-4 border-t border-slate-700">
          <button
            onClick={handleLogout}
            className="w-full px-3 py-2 rounded-md text-sm font-medium text-slate-300 hover:bg-red-700 hover:text-slate-100 transition-colors text-left"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
