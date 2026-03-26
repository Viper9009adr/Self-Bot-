const TOKEN_KEY = 'self-bot-token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = getToken()
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
}

// Auth — CRITICAL-4: /auth/login NOT /api/login
export async function login(username: string, password: string): Promise<{ token: string }> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// Dashboard
export async function getStatus(): Promise<unknown> {
  return (await apiFetch('/api/status')).json()
}

export async function getSessions(): Promise<unknown> {
  return (await apiFetch('/api/sessions')).json()
}

export async function getTools(): Promise<unknown> {
  return (await apiFetch('/api/tools')).json()
}

// Allowlist
export async function getAllowlist(): Promise<unknown> {
  return (await apiFetch('/api/allowlist')).json()
}

export async function grantUser(userId: string): Promise<unknown> {
  return (await apiFetch('/api/allowlist/grant', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })).json()
}

export async function revokeUser(userId: string): Promise<unknown> {
  return (await apiFetch(`/api/allowlist/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })).json()
}

// Chat
export async function sendChat(message: string): Promise<{ text: string; format: string }> {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
