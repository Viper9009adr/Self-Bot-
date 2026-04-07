---
name: opencode
description: AI coding assistant - interact with OpenCode CLI
command: opencode
args:
  - --yes
arguments:
  - name: provider
    type: string
    required: false
    description: LLM provider (openai, anthropic, etc.)
    default: openai
  - name: model
    type: string
    required: false
    description: Model name
  - name: project
    type: string
    required: false
    description: Working directory
cwd: /home
timeout: 300000
---

# OpenCode Skill

This skill launches the OpenCode CLI tool for AI-assisted coding.

## Usage

```json
{
  "action": "start",
  "skillName": "opencode",
  "args": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "project": "/home/myproject"
  }
}
```

## Requirements

- OpenCode must be installed: `npm install -g opencode`
- Valid API key for the selected provider