## Working rules

Make the smallest change that solves the real problem. Do not add abstractions,
options, layers, frameworks, or defensive code nobody asked for. Do not refactor
unrelated code.

Review your work at most once. Fix real problems, then stop. Do not polish
repeatedly or loop on reviews. Do not launch reviewer agents unless something is
genuinely risky. When it works and tests pass, finish.

Always run pi with stdin redirected from /dev/null. In tests that spawn Pi,
use stdin set to ignore. Do not disable sessions when using pi-subagent.
