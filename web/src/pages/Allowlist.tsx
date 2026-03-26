import { useEffect, useState } from 'react'
import { getAllowlist, grantUser, revokeUser } from '../api'

interface AllowlistEntry {
  userId: string
  grantedAt?: string
  [key: string]: unknown
}

export default function Allowlist() {
  const [entries, setEntries] = useState<AllowlistEntry[]>([])
  const [newUserId, setNewUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchList() {
    setLoading(true)
    setError(null)
    try {
      const data = await getAllowlist()
      setEntries(Array.isArray(data) ? (data as AllowlistEntry[]) : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load allowlist')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchList()
  }, [])

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault()
    const userId = newUserId.trim()
    if (!userId) return
    setActionLoading(true)
    setError(null)
    try {
      await grantUser(userId)
      setNewUserId('')
      await fetchList()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to grant user')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRevoke(userId: string) {
    setActionLoading(true)
    setError(null)
    try {
      await revokeUser(userId)
      await fetchList()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke user')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">Allowlist</h1>

      {/* Grant form */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-5">
        <h2 className="text-lg font-semibold text-slate-200 mb-3">Grant Access</h2>
        <form onSubmit={(e) => void handleGrant(e)} className="flex gap-2">
          <input
            type="text"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            placeholder="User ID (e.g. telegram:123456)"
            className="flex-1 px-3 py-2 rounded-md bg-slate-700 border border-slate-600 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            type="submit"
            disabled={actionLoading || !newUserId.trim()}
            className="px-4 py-2 rounded-md bg-green-600 hover:bg-green-700 disabled:bg-green-900 disabled:cursor-not-allowed text-white font-medium transition-colors"
          >
            Grant
          </button>
        </form>
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-400 bg-red-900/30 border border-red-700 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Entries table */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <h2 className="text-lg font-semibold text-slate-200 px-5 py-3 border-b border-slate-700">
          Allowed Users ({entries.length})
        </h2>
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <div className="w-6 h-6 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-slate-500 px-5 py-4">No users in allowlist.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-400">
                <th className="px-5 py-2 font-medium">User ID</th>
                <th className="px-5 py-2 font-medium">Granted At</th>
                <th className="px-5 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.userId} className="border-b border-slate-700 last:border-0">
                  <td className="px-5 py-2 text-slate-300 font-mono">{entry.userId}</td>
                  <td className="px-5 py-2 text-slate-400">
                    {entry.grantedAt
                      ? new Date(entry.grantedAt).toLocaleString()
                      : '—'}
                  </td>
                  <td className="px-5 py-2">
                    <button
                      onClick={() => void handleRevoke(entry.userId)}
                      disabled={actionLoading}
                      className="px-3 py-1 rounded bg-red-700 hover:bg-red-800 disabled:bg-red-900 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
