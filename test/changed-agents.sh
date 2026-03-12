#!/usr/bin/env bash
# determines which agents need testing based on changed files.
# reads changed file paths from stdin (JSON array or newline-delimited).
# outputs a JSON array of agent names to stdout.
#
# only agents whose harness file changed AND are exported from index.ts are included.
# shared.ts/index.ts and other non-harness action changes fall back to opentoad as a canary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_INDEX="$SCRIPT_DIR/../agents/index.ts"

# build the set of active agents from index.ts imports (portable, no -P)
active_agents=()
while IFS= read -r line; do
  [[ -n "$line" ]] && active_agents+=("$line")
done < <(sed -n 's/.*from "\.\/\([^"]*\)\.ts".*/\1/p' "$AGENTS_INDEX" | grep -v shared)

# read stdin - auto-detect JSON array vs newline-delimited
input=$(cat)
if echo "$input" | jq -e 'type == "array"' > /dev/null 2>&1; then
  files=$(echo "$input" | jq -r '.[]')
else
  files="$input"
fi

is_active_agent() {
  local name="$1"
  for a in "${active_agents[@]}"; do
    [[ "$a" == "$name" ]] && return 0
  done
  return 1
}

# find which agent harness files changed
changed_agents=()
has_non_agent_change=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    action/agents/shared.ts|action/agents/index.ts)
      has_non_agent_change=true
      ;;
    action/agents/*.ts)
      agent_name="$(basename "$file" .ts)"
      if is_active_agent "$agent_name"; then
        changed_agents+=("$agent_name")
      else
        # legacy/inactive agent file changed — treat as non-agent change
        has_non_agent_change=true
      fi
      ;;
    action/*)
      has_non_agent_change=true
      ;;
  esac
done <<< "$files"

# output agents based on change type.
# non-agent action changes always include opentoad as a canary.
if $has_non_agent_change; then
  changed_agents+=("opentoad")
fi

if [[ ${#changed_agents[@]} -gt 0 ]]; then
  printf '%s\n' "${changed_agents[@]}" | sort -u | jq -R . | jq -sc .
else
  echo '[]'
fi
