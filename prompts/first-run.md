Initialize Evergreen in this extension repo: {{repoPath}}

If the checkout has uncommitted changes, discard them (git reset --hard && git clean -fd), then start. Do not stash.

Read the code, README, and git history to determine the extension's real intent.
Check existing test coverage. Add integration and e2e tests that protect that
intent, not just isolated functional behavior. Add a `test:evergreen` script that
runs unit, integration, and e2e tests. E2E must run the globally installed Pi from
`$EVERGREEN_PI_BIN`, falling back to `pi` on PATH, and use
`$EVERGREEN_E2E_MODEL` for model calls.

Write root EVERGREEN.md, about 60 lines maximum. Start with `## Summary` and at
most 6 bullets covering intent, Pi touchpoints, internal or undocumented Pi APIs,
and main weak points. Follow with sections named Intent, Pi integration (public
APIs), Internal Pi APIs, Weak points, Tests, and Relevant changelog topics.
Explain which tests protect the intent. Record absent internal API use plainly.

Run `npm run test:evergreen` and fix failures until it passes. Commit and push to
origin. Do not bump the version or publish unless runtime code had to change to
fix a real bug. In that case, follow the patch, push, and publish instructions in
{{workerPrompt}} after committing.

Pull failures from this run:
{{pullFailures}}
