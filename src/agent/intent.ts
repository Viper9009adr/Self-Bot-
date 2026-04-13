export type IntentPhase = {
  pass: boolean;
  skillHint?: string;
  payload?: string;
  error?: string;
};

const PREFIX_RE = /^\s*([a-z_][a-z0-9_-]*)\s*:\s*([\s\S]*)$/i;

export function detectTerminalIntent(text: string): IntentPhase {
  const match = PREFIX_RE.exec(text);
  if (!match) {
    return { pass: false, error: 'No terminal intent prefix detected' };
  }

  const skillHint = (match[1] ?? '').trim().toLowerCase();
  const payload = (match[2] ?? '').trim();

  if (!payload) {
    return { pass: false, error: 'Terminal intent payload is empty' };
  }

  return {
    pass: true,
    skillHint,
    payload,
  };
}
