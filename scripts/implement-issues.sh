#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY="${REPOSITORY:-matisfogel99/pi-agent-view}"
readonly PI_BIN="${PI_BIN:-pi}"
readonly MODEL="${MODEL:-openai-codex/gpt-5.6-sol}"
readonly THINKING="${THINKING:-medium}"
readonly LOG_DIR="${LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-agent-view/issue-loop}"
readonly -a ISSUES=(2 3 4 5)

mkdir -p "$LOG_DIR"
cd "$REPO_ROOT"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

issue_state() {
  gh issue view "$1" --repo "$REPOSITORY" --json state --jq .state
}

require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "The worktree is not clean. Commit or stash changes before continuing:" >&2
    git status --short >&2
    exit 1
  fi
}

require_command git
require_command gh
require_command "$PI_BIN"

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

require_clean_worktree

echo "Repository: $REPOSITORY"
echo "Model:      $MODEL"
echo "Thinking:   $THINKING"
echo "Issues:     ${ISSUES[*]}"
echo

for issue in "${ISSUES[@]}"; do
  state="$(issue_state "$issue")"
  if [[ "$state" == "CLOSED" ]]; then
    echo "Issue #$issue is already closed; skipping."
    continue
  fi

  require_clean_worktree
  git pull --ff-only

  log_file="$LOG_DIR/issue-${issue}-$(date -u +%Y%m%dT%H%M%SZ).log"
  prompt=$(cat <<EOF
Fully implement GitHub issue #$issue in the repository $REPOSITORY, then close issue #$issue only after the implementation is complete.

Work autonomously through the entire task. Do not stop after analysis or planning.

Required workflow:
1. Read the full parent specification in issue #1, the full body and comments of issue #$issue, and every issue listed as a blocker. Confirm all blockers are closed before changing code.
2. Inspect the current repository, its documentation, and its existing implementation before deciding how to proceed. Respect the terminology and architectural decisions in the specification.
3. Implement every acceptance criterion in issue #$issue. Do not implement later tickets except for minimal compatibility needed by this issue.
4. Add meaningful tests at the testing seams agreed in the specification. Do not make network calls or require model-provider credentials in tests.
5. Run all relevant tests, type checks, and other repository checks. Fix failures rather than documenting them away.
6. Review the resulting diff for correctness, security, lifecycle leaks, race conditions, and accidental scope expansion.
7. Commit all implementation changes with a descriptive commit message and push the current branch to origin.
8. Only after the pushed commit satisfies every acceptance criterion, close issue #$issue with a concise comment summarizing the implementation and verification performed.

If an acceptance criterion cannot be completed, a blocker is still open, checks cannot pass, or changes cannot be pushed, leave issue #$issue open and exit with a clear explanation. Never close an incomplete issue.
EOF
)

  echo
  echo "============================================================"
  echo "Implementing issue #$issue"
  echo "Log: $log_file"
  echo "============================================================"

  "$PI_BIN" \
    --print \
    --no-session \
    --approve \
    --model "$MODEL" \
    --thinking "$THINKING" \
    "$prompt" 2>&1 | tee "$log_file"

  state="$(issue_state "$issue")"
  if [[ "$state" != "CLOSED" ]]; then
    echo "Pi exited without closing issue #$issue. Stopping the loop." >&2
    echo "Review the log: $log_file" >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Issue #$issue was closed, but the worktree contains uncommitted changes. Stopping." >&2
    git status --short >&2
    exit 1
  fi

  echo "Issue #$issue is closed. Continuing to the next issue."
done

echo
echo "All issues in the implementation loop are closed."
