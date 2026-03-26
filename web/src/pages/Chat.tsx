import { useEffect, useRef, useState } from 'react'
import { sendChat } from '../api'

interface Message {
  id: string
  role: 'user' | 'bot'
  text: string
}

let msgCounter = 0
function nextId(): string {
  return String(++msgCounter)
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { id: nextId(), role: 'user', text }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setError(null)
    setLoading(true)

    try {
      const response = await sendChat(text)
      const botMsg: Message = { id: nextId(), role: 'bot', text: response.text }
      setMessages((prev) => [...prev, botMsg])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('504') || message.toLowerCase().includes('timeout')) {
        setError('Request timed out. The bot may be busy — please try again.')
      } else {
        setError(message || 'Failed to send message.')
      }
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      <h1 className="text-2xl font-bold text-slate-100 mb-4">Chat</h1>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 mb-4">
        {messages.length === 0 && (
          <p className="text-slate-500 text-sm text-center mt-8">
            Send a message to start chatting with Self-BOT.
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-green-800 text-slate-100'
                  : 'bg-slate-700 text-slate-200'
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-700 px-4 py-2 rounded-lg text-sm text-slate-400 flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin inline-block" />
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-400 bg-red-900/30 border border-red-700 rounded-md px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {/* Input row */}
      <div className="flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="flex-1 px-3 py-2 rounded-md bg-slate-700 border border-slate-600 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
        />
        <button
          onClick={() => void handleSend()}
          disabled={loading || !input.trim()}
          className="px-4 py-2 rounded-md bg-green-600 hover:bg-green-700 disabled:bg-green-900 disabled:cursor-not-allowed text-white font-medium transition-colors self-stretch"
        >
          Send
        </button>
      </div>
    </div>
  )
}
