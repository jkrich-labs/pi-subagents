# pi-subagents — one-command verification (S-06).
#
# make verify   → typecheck + every test suite (spawns real pi children;
#                 requires the pi binary on PATH and provider auth for
#                 openai-codex/gpt-5.6-luna, same as an interactive pi run)
# make test     → test suites only
# make unit     → pure unit tests only (no child processes, no provider auth)
# make smoke    → scripted PTY smoke of the TUI slice (manual-quality evidence)

.PHONY: verify typecheck test unit smoke

verify: typecheck test

typecheck:
	npx tsc --noEmit -p tsconfig.json

test:
	node --test tests/*.test.ts

unit:
	node --test tests/ui.test.ts tests/agents.test.ts

smoke:
	python3 scripts/smoke-tui.py
