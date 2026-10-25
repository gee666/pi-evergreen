# Pi evergreen

Nightly maintenance for your active GitHub `pi-*` repositories. A Node process runs the workflow at **02:00 in your explicitly configured timezone**, using `node-cron`. A systemd user service keeps the scheduler alive. No system cron entry or systemd timer.

## Workflow

1. Finish interrupted releases before installing a newer Pi runtime.
2. Try `pi update`. On failure, run `mise upgrade pi` and `mise reshim`. Read back `pi --version`, then run `pi update --extensions`.
3. Discover the configured owner's active `pi-*` repositories through authenticated, paginated GitHub API calls. Discovery includes private repositories when the owner is the authenticated account. Archived, disabled and deleted repositories are not maintained. Previously cloned inactive repositories stay untouched on disk.
4. Clone missing repositories and fast-forward existing default branches into `extensionsDir`. Refuse dirty checkouts, unexpected origins, wrong branches and unrelated unpushed commits. Never reset user work or force-push.
5. If Pi's version matches the last completed run and all active repositories have their knowledge and saved test commands, stop after synchronization. Missing first-run metadata or unfinished workers still require work. With no saved version, perform the full first-run audit.
6. Create persistent, Evergreen-owned working copies under `.state/`. Agents and build tools work there, not in your canonical checkouts. Install dependencies without install scripts, override declared Pi SDK dependencies to the target version, verify installed SDK versions, then run tests. Legacy `@mariozechner/pi-*` names and npm aliases map to the current SDK. Missing tests are a failure.
7. On the first run, launch one Pi subagent per extension for a thorough intent and coverage audit, even if a knowledge file already exists. Create or refresh its section in the single shared `.state/extensions.md`, identify fragile assumptions, and add meaningful unit, integration and e2e tests as needed. Newly discovered extensions without knowledge or a saved test-command entry get this audit on their next compatibility check. Agents also report the full test commands for their own extension; the parent writes these entries into `.env` serially.
8. Fetch the changelog at the installed Pi release tag. A read-only Pi session compares all intervening changes with every extension's knowledge and test results. It returns a relevance decision and migration reasoning for each repository.
9. Launch maintenance subagents only for relevant changes or failing tests. Unrelated scrollbar changes with passing tests do not trigger a worker for SSH tool routing. New tools or changed execution behavior do. Internal dependencies warrant careful behavioral assessment, not an unconditional worker for unrelated changes.
10. Workers fix compatibility, adopt useful public APIs, preserve all existing functionality, and keep tests and knowledge current. Re-test changes, bump the npm patch version, test the release version, commit, push the default branch, then publish to npm. An unchanged review gets no empty release. Knowledge is local bookkeeping, not a reason by itself to publish an extension. Changes to its tests or implementation count as real changes.
11. Record the completed Pi version only after all required work succeeds. Journals resume interrupted pushes and publications without another patch bump. Existing npm versions must match the recorded commit's `gitHead`, or publication recovery fails.

Subagents are independent Pi CLI processes, with configurable concurrency. They do not depend on a particular Pi subagent extension. Extension discovery is disabled for maintenance sessions to avoid recursive delegation and interactive extension dialogs. The main changelog session has no tools. Prompts travel through stdin so a long first-run changelog does not exceed OS argument limits.

## Tests must enforce intent

The first audit should do the creative work once, building regression coverage that catches future violations automatically. Each extension intent and fragile assumption should map to a named, meaningful test in its knowledge file. Existing green tests are evidence, not proof.

For example, a prompt-replacing extension must keep the intended replacement effective in every relevant place and turn. A test of its replacement helper does not establish that. Where runtime integration matters, workers must run the actual Pi CLI with the local extension loaded, exercise realistic lifecycle transitions, and inspect actual provider-bound prompts and session artifacts. Harmless sentinel text should reveal if forbidden original content leaks into an outgoing request. A final model response, or a session transcript that omits system prompts, is not sufficient evidence.

The audit asks workers to verify their tests can detect violated invariants through a negative control or temporary reverted fix. It also asks them to consider multi-turn behavior, retries, compaction, event ordering, prompt rebuilding and tool discovery where relevant. Changes to per-turn system-prompt delivery can break a prompt-replacing extension without changing its imported APIs.

Automatic test discovery runs `npm test`, then `check`, `build`, and `test:e2e` when those scripts exist. Required e2e tests must not silently skip. Live e2e tests use the **separately configured e2e provider/model**, never an implicit maintenance-model fallback. Choose a cheap model such as `gpt-6-luna` explicitly if that is what you want. There is no hard-coded model default.

Tests receive:

- `PI_EVERGREEN_E2E=1`
- `PI_EVERGREEN_E2E_PROVIDER`
- `PI_EVERGREEN_E2E_MODEL`
- `PI_EVERGREEN_E2E_REASONING`

Workers must make generated e2e tests honor these variables. They should keep real-model prompts and budgets small. Custom test commands replace ordinary script discovery, but an existing `test:e2e` script still runs unless explicitly included already.

## Application .env only

Evergreen reads **its own `.env` in the application root**. It does not read Pi settings and does not infer application settings from ambient environment variables. Pi itself still uses its normal independent credentials.

- `.env.example` is committed. All values are blank, not defaults.
- `.env` is your local file, ignored by Git and kept at mode 0600. On omarchy-red it has been filled in using the requested model selections and this machine's paths. The committed example stays blank.
- No template is copied automatically by the runner or service installer.
- Missing required values fail validation before updates, model calls or repository changes.

Required keys:

| Key | Meaning |
| --- | --- |
| `PI-EXTENSIONS-DIR` | Canonical extension checkout directory |
| `PI-GITHUB-OWNER` | GitHub account owning the repositories |
| `PI-AGENT-MODEL` | Maintenance provider/model/reasoning-level |
| `PI-E2E-MODEL` | Independent e2e provider/model/reasoning-level |
| `PI-TIMEZONE` | IANA timezone for 02:00 |
| `PI-CONCURRENCY` | Integer 1 through 8 |
| `PI-COMMAND-TIMEOUT-MS` | Command deadline, integer milliseconds >=1000 |
| `PI-AGENT-TIMEOUT-MS` | Pi agent deadline, integer milliseconds >=1000 |
| `PI-PUBLISH-ACCESS` | `public` or `restricted` |

Model syntax examples, not active defaults:

```dotenv
PI-AGENT-MODEL=openai/gpt-6.1-sol/medium
PI-E2E-MODEL=openai/gpt-6-luna/low
```

### npm credential

Set `NPM_TOKEN` in the ignored application `.env`. Evergreen reads it for each run, and the independent repair supervisor reloads it on each retry. Token rotation does not require modifying application code or logging in through npm. The template contains only an empty placeholder.

Both processes create a private temporary npm user configuration referencing the token through a child-process environment variable. The literal token is not written into the generated npmrc or printed by `--check-config`. Existing user npm configuration is preserved, and the temporary configuration is removed when the run/attempt ends. The main runner redacts the active token from captured output and logs. Use a token with the necessary package publishing permissions and unattended 2FA policy.

`.env` must have mode 0600. Never commit it or paste its contents into chat. Node processes and repository tests inherit the credential, so this still requires trusted repositories and a trusted maintenance account.

Check the exact authentication path used by the application without running maintenance or publishing:

```sh
node src/cli.js --check-auth
```

This checks authenticated GitHub account, npm identity, both Pi model credentials, and a dry-run Git push. Diagnostics never launch the repair service on failure.

Choose the provider that actually provides the model and has credentials on this machine. Reasoning is mandatory: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Maintenance invocations pass it explicitly through `--thinking`; generated e2e tests must do the same using their separate selection. Pi may clamp unsupported reasoning levels to a model's capabilities.

There is no manual test-command mapping setting. During the first run, each extension agent discovers, adds and runs its full test suites, then reports the commands to the parent. Evergreen appends an automatic entry for that repository, such as:

```dotenv
PI-TEST-COMMANDS-pi-example='["npm test","npm run check","npm run test:e2e"]'
```

Only the parent writes `.env`, one update at a time. It preserves other entries, comments and model selections. Later workers keep their own mapping current if scripts change. Entries with unusually complex quoting may use a `base64:` encoded JSON value for exact round-tripping. Normal entries remain readable JSON arrays.

Commands are trusted shell commands run with `bash -o pipefail`. Empty or multiline commands are rejected. An existing `test:e2e` script still runs even if absent from a reported command list. Before an extension has a saved mapping, Evergreen discovers npm test/check/build/e2e scripts for the initial check. Non-npm projects need an npm package/test setup before this runner can publish them.

Paths should be absolute or start with `~`. The hyphenated keys are parsed by dotenv directly. Do not `source .env` into a shell or load it as a systemd EnvironmentFile: those mechanisms do not support these variable names consistently.

## Install on Linux

Requires Node >=22.19, npm, Git, GitHub CLI, `flock`, Pi and mise. mise must provide a working `pi` tool for fallback updates and recovery of unfinished releases that still need tests.

```sh
npm ci --ignore-scripts
# Fill in every required value in the application .env file.
# On a fresh clone, manually copy .env.example to .env first.
node src/cli.js --check-config
```

Authenticate independently on this machine:

```sh
gh auth login
# Configure Git credentials only if Git pushes do not already work.
gh auth setup-git
# Set NPM_TOKEN in the application .env.
pi auth check --provider YOUR_PROVIDER --model YOUR_MODEL
pi auth check --provider YOUR_E2E_PROVIDER --model YOUR_E2E_MODEL
```

Unattended npm publishing needs appropriate publish permissions and a narrowly scoped automation/granular token with the registry's required 2FA bypass. Interactive OTP publication cannot finish unattended. Keep credentials outside the repositories. Never copy Pi OAuth tokens between machines or environments.

Once configuration validates:

```sh
./scripts/install-service.sh
loginctl enable-linger "$USER"
```

The installer does not generate `.env` and refuses to install/start when its required values are incomplete. The service reads the same application `.env` directly. Never commit that file or credentials.

Linger lets the user service continue after logout. Administrator approval may be needed to enable it. The machine must be powered on and awake at 02:00. Missed runs are not replayed automatically.

```sh
npm run once
systemctl --user status pi-evergreen
journalctl --user -u pi-evergreen -f
systemctl --user restart pi-evergreen
systemctl --user disable --now pi-evergreen
```

A fresh Node process runs each nightly workflow, picking up code changes. Scheduler code, dependencies and timezone changes require a service restart. The application `.env`, including model selections and reasoning, is read each run. A kernel advisory lock prevents overlapping runs and releases automatically on exit or reboot.

## Shared knowledge format

`.state/extensions.md` has one section per extension. Agents return their own Markdown fragment; the parent merges it without overwriting the other sections. Small HTML section markers identify update boundaries. They do not change the rendered Markdown. Do not remove those markers.

```md
<!-- pi-evergreen: {"usesUndocumentedApis": true} -->
# Compatibility notes
- Intent: route every Pi tool through SSH without changing its result contract.
- Dependencies: exact registration/execution APIs and import paths.
- Invariant: tools introduced after session startup must also route remotely.
- Coverage: tests/tool-routing.e2e.test.ts observes actual tool requests.
- Fragile assumption: tool discovery runs once per session.
- Relevant: new tools, execution, serialization, cancellation and lifecycle.
- Usually unrelated: scrollbar, colors and interactive layout.
- Opportunity: replace private executor access if a public routing API appears.
```

Workers must audit code before setting `usesUndocumentedApis` to false. Undocumented behavior counts, even without a private import. Missing or invalid declarations are treated as unknown internal dependencies, never as proof of safety. Knowledge stays short, roughly 40 lines, and records real coverage and remaining limitations honestly.

## Independent self-repair

The scheduler and repair supervisor are separate systemd user services. A workflow error makes the scheduler exit unsuccessfully; its `OnFailure` starts `pi-evergreen-repair.service`. Startup/import failures use the same trigger. Errors from a manual `--once` run also request that separate service. `--check-config` is diagnostic and never starts repair.

The repair supervisor is `scripts/repair.mjs`, a standalone Node program using only built-in modules, not Evergreen's imports or npm dependencies. It remains alive while stopping, repairing, testing and restarting the main app. systemd restarts the supervisor itself if it crashes. A separate repair lock prevents duplicate supervisors.

It uses the configured `PI-AGENT-MODEL` and reasoning. It asks an agent to fix real bugs without changing the system's purpose, deleting data, weakening tests, bypassing authentication or changing your model choices. It validates externally rather than trusting the agent's final response. The intended sequence is dependency installation, tests, checks, a full `--once` validation, deployment, a short healthy-service observation, then commit and push. Failures loop with backoff. After a successful push and running-service check, the supervisor exits.

During repair validation, Evergreen's own repository is handled by the supervisor's tests and commit/deployment transaction, not a second extension worker. Other extension repositories still follow the ordinary workflow. This avoids a dirty canonical self-checkout or competing self-release while repair is in progress. Recursive repair triggers are suppressed only inside supervisor validation.

Pre-existing user edits are not automatically swept into a repair commit. Repair-created changes and phase information survive retries. `.env`, `.state/`, `tmp/`, credentials and protected instruction files are excluded from repair commits. The supervisor itself is protected from its repair agent's edits.

Missing model credentials cannot be repaired by inventing a login. The supervisor waits and retries authentication rather than spending repeated model calls, switching providers or disabling requirements. GitHub/npm permissions, outages and publication conflicts can also require external action. This is a recovery loop, not a promise that software or external services can never fail.

```sh
systemctl --user status pi-evergreen pi-evergreen-repair
journalctl --user -u pi-evergreen-repair -f
# Start recovery manually if needed:
systemctl --user start pi-evergreen-repair
```

Self-repair requires this Git checkout, a writable origin, valid credentials and a working Node/Pi executable. Keep the checkout, `.env` and local state owned by the maintenance account.

## Recovery and limits

The state location is fixed inside the application. There is no state-directory setting:

- `.state/extensions.md`: one plain Markdown file with a section per extension, its intent, dependencies, weaknesses, test coverage and useful API opportunities.
- `.state/state.json`: last completed Pi version, working-copy identities, first-run audit records and release journals.
- `.state/runs/`: test results, changelogs, model responses and errors.
- `.state/workspaces/<pi-version>/<repo>/`: managed working copies retaining interrupted edits for retry.
- `tmp/`: disposable development/test artifacts.

Both `.state/` and `tmp/` are Git-ignored. Each run cleans run logs older than 14 days and top-level temporary entries older than 7 days, under the exclusive run lock. Cleanup does not follow symlinks or remove shared knowledge, version history, recovery journals or working copies. Those working copies are retained for recovery and can consume disk space.

Canonical checkouts only receive fast-forward pulls and get release commits on their next synchronization.

After a push or publication failure, fix credentials/access and rerun rather than deleting the journal. Pending repositories that disappear, become archived, transfer ownership or change default branch block recovery instead of being published blindly. Inspect and deliberately resolve/cancel such journals. Unexpected package identity or Git changes require inspection of the managed working copy; the runner does not discard them automatically.

Workers and tests execute as your user. Working directories, separate copies and `--no-approve` are **not a security sandbox**. They can access that user's files and credentials. Use a dedicated maintenance account or container, restricted credentials and trusted repositories. The parent validates publication identity and refuses protected instruction or credential filenames, but cannot prevent every bad model action or malicious test. Autonomous tests and publishing do not guarantee semantic correctness.

Command deadlines kill ordinary process groups and close captured pipes. The service uses `KillMode=control-group` for descendant cleanup on shutdown. A deliberately detached process may outlive an individual command timeout until service shutdown. Use OS isolation for stronger restrictions. Install scripts are disabled; projects needing generated artifacts must create them through explicit test/build commands.

## Development

```sh
npm test
npm run check
npm pack --dry-run
```

Tests use isolated fixtures in the ignored project `tmp/` directory. They exercise update fallback, discovery, version gates, SDK setup, first-run audits, intent/e2e instructions, model configuration, relevance filtering, worker recovery, publication order and retries. They do not call live models or publish packages.
