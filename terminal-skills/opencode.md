---
name: opencode
description: AI coding assistant - interact with OpenCode CLI. Use approve=true to auto-approve file permission changes.
command: opencode
args:
  - run
requiresShellMode: true
env:
  PATH: /home/viper9009adr/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
arguments:
  - name: prompt
    type: string
    required: true
    description: Task prompt for OpenCode to execute
  - name: approve
    type: boolean
    required: false
    default: true
    description: Auto-approve file permission changes (adds --dangerously-skip-permissions flag)
cwd: /home
timeout: 30000
shellQuoting:
  argRules:
    - position: 0
      quote: false
    - position: -1
      quote: true
---