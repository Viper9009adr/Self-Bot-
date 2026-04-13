export type AliasPhase = {
  pass: boolean;
  requested: string;
  resolved?: string;
  usedFallback: boolean;
  error?: string;
};

const FALLBACKS: Record<string, string> = {
  code_editor: 'opencode',
};

/** Resolve requested skill names and fallback aliases against available skills. */
export function resolveSkillAlias(requested: string, availableSkills: readonly string[]): AliasPhase {
  const normalized = requested.trim().toLowerCase();
  const available = new Set(availableSkills.map((s) => s.trim().toLowerCase()));

  if (available.has(normalized)) {
    return { pass: true, requested: normalized, resolved: normalized, usedFallback: false };
  }

  const fallback = FALLBACKS[normalized];
  if (fallback && available.has(fallback)) {
    return { pass: true, requested: normalized, resolved: fallback, usedFallback: true };
  }

  return {
    pass: false,
    requested: normalized,
    usedFallback: false,
    error: `Skill alias '${normalized}' is unavailable`,
  };
}
