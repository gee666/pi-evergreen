# Pi evergreen

Nightly maintenance for your active GitHub `pi-*` repositories. A Node process schedules runs at **02:00 in the machine's timezone** using `node-cron`. A systemd user service keeps that process alive. There is no system cron entry or systemd timer.

## What a run does

1. Finish any interrupted release before installing a newer Pi runtime.
2. Try `pi update`. If it fails, run `mise upgrade pi` and `mise reshim`. Read back `pi --version`, then run `pi update --extensions`.
3. Use authenticated GitHub CLI pagination to discover the configured owner's active `pi-*` repositories. For your own account, discovery includes private repositories. Archived, disabled and deleted repositories are not maintained. Previously cloned inactive repositories stay on disk, untouched.
4. Clone missing repositories and fast-forward existing default branches into the extensions directory. Refuse dirty checkouts, unexpected origins, wrong branches and unrelated unpushed commits. Never force-push or reset user work.
5. If Pi's version matches the last completed run, stop after repository synchronization. The first run has no baseline and performs the full check.
6. Make persistent Evergreen-owned working copies under the state directory. Install dependencies without install scripts, override declared Pi SDK dependencies to the current Pi version, verify their installed versions, and run tests. Legacy `@mariozechner/pi-*` dependencies and npm aliases are mapped to the current SDK. Run `test`, plus `check` and `build` when present. A missing test suite is a failure, not a pass.
7. On the first compatibility check for each extension, launch a Pi subprocess to create `PI_COMPATIBILITY.md` and regression tests for fragile assumptions. The file records the extension's intent, relevant APIs, undocumented dependencies, lifecycle assumptions, public-API replacement opportunities, and named tests. Keep it short, roughly 40 lines.
8. Fetch Pi's changelog at the installed release tag. A read-only Pi session compares the complete intervening changelog against each extension's knowledge and test results. It returns a separate relevance decision for every extension. Bug fixes and unrelated changes with passing tests need no worker.
9. Launch separate Pi subprocesses only for relevant extensions, failing tests, or undocumented API/behavior dependencies. Unknown or missing internal-API declarations fail closed and get a review. These are independent subagents, limited to two concurrent processes by default, not a dependency on a particular Pi subagent extension.
10. Workers investigate behavioral consequences, not just API renames. For example, rebuilding the system prompt every turn is relevant to a prompt-replacing extension even with green unit tests. Workers should test realistic multi-turn behavior, fix compatibility, adopt worthwhile public APIs, preserve existing functionality, and update the knowledge file.
11. Re-test changes, bump the npm patch version, test the release version, commit, push the default branch, then publish to npm. An unchanged review gets no empty release. Knowledge/test bootstrap changes count as real changes. The parent controls releases, not the worker prompt.
12. Record the completed Pi version only when all required work succeeds. Release journals resume interrupted pushes/publications without a second patch bump. A published-version collision must match the journalled commit's npm `gitHead`, or the run fails.

The main changelog session has no tools and cannot edit files. Workers use explicit provider/model settings and built-in tools with extension discovery disabled, avoiding recursive subagent extensions and interactive extension dialogs. Prompts travel through stdin, so long first-run changelogs do not exceed OS argument limits.

## Install on Linux

Requires Node >=22.19, npm, Git, `gh`, `flock`, Pi and mise. mise must provide a working `pi` tool for update fallback and recovery of unfinished releases that still need tests.

```sh
npm ci --ignore-scripts
mkdir -p ~/.config/pi-evergreen
cp settings.example.json ~/.config/pi-evergreen/settings.json
# Edit extensionsDir and githubOwner as needed.
node src/cli.js --check-config
```

Authenticate on this machine using independent local credentials:

```sh
gh auth login
gh auth setup-git
npm login
pi auth check --provider openai-codex --model gpt-6.1-sol
```

For unattended npm publication, use a narrowly scoped automation/granular token with permission to publish each package and the registry's required 2FA bypass. Configure npm normally outside the repositories. Interactive OTP publication cannot finish unattended. Set up new package names and publish permissions before relying on automation. Never copy Pi OAuth tokens between machines or environments.

Install the scheduler:

```sh
./scripts/install-service.sh
loginctl enable-linger "$USER"
```

Linger lets the user service continue after logout. If your machine requires administrator approval for that command, enable it through the administrator. The machine must be powered on and awake at 02:00. Missed runs are not replayed automatically. Run one manually when needed.

```sh
npm run once
systemctl --user status pi-evergreen
journalctl --user -u pi-evergreen -f
systemctl --user restart pi-evergreen
systemctl --user disable --now pi-evergreen
```

The scheduler starts a fresh Node process for each run so updates to Evergreen's workflow code apply the following night. Changes to the scheduler itself, its dependencies, or timezone require a service restart. A kernel advisory lock prevents overlapping manual and scheduled runs and releases on process death or reboot.

## Settings

Evergreen reads, in increasing precedence:

1. `evergreen` in Pi's user `settings.json`.
2. `~/.config/pi-evergreen/settings.json`, or `PI_EVERGREEN_CONFIG`.
3. Environment overrides listed below.

Pi's user settings path follows `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. Provider/model default to Pi's `defaultProvider` and `defaultModel`. On this machine those are `openai-codex` and `gpt-6.1-sol`. No model is hard-coded.

| Environment | Setting |
| --- | --- |
| `PI-EXTENSIONS-DIR` or `PI_EXTENSIONS_DIR` | `extensionsDir` |
| `PI_EVERGREEN_GITHUB_OWNER` | `githubOwner`, otherwise the authenticated GitHub login |
| `PI_EVERGREEN_PROVIDER` or `PI_PROVIDER` | `provider` |
| `PI_EVERGREEN_MODEL` or `PI_MODEL` | `model` |
| `PI_EVERGREEN_STATE_DIR` | `stateDir`, default `~/.local/state/pi-evergreen` |
| `PI_EVERGREEN_CONCURRENCY` | `concurrency`, integer 1 through 8 |
| `TZ` | `timezone`, otherwise the machine's timezone |

The literal `PI-EXTENSIONS-DIR` key is also accepted in Pi's top-level settings and Evergreen settings. Use the underscore environment spelling in shell `export` commands. Relative paths resolve from the process working directory; absolute paths or `~` paths are recommended.

For service-specific environment variables, use `~/.config/pi-evergreen/environment`, a systemd environment file, then restart the service. It is optional. Changes to the JSON settings and model/provider are read each nightly run. Set secrets only in user-owned files with mode 0600, never in Git.

Additional JSON settings:

```json
{
  "extensionsDir": "~/Work/pi-extensions",
  "githubOwner": "gee666",
  "concurrency": 2,
  "commandTimeoutMs": 1200000,
  "agentTimeoutMs": 5400000,
  "publishAccess": "public",
  "testCommands": {
    "pi-example": ["npm test", "npm run integration", "npm run check"]
  }
}
```

Custom test commands replace automatic script discovery for that repository. They are trusted shell commands, run with `bash -o pipefail`. Non-npm projects need an explicit npm package/test setup before this runner can publish them. The configured owner defaults to your own account; discovery of a different user's repositories uses GitHub's public user-repositories endpoint.

## Knowledge file format

```md
<!-- pi-evergreen: {"usesUndocumentedApis": true} -->
# Compatibility notes
- Intent: route every Pi tool through SSH without changing its result contract.
- Dependencies: list exact tool registration/execution hooks and import paths here.
- Fragile assumption: tool discovery runs once per session. Test: tests/tool-routing.test.ts.
- Relevant: new tools, tool execution, serialization, cancellation, transport lifecycle.
- Usually unrelated: scrollbar, colors, interactive layout.
- Opportunity: replace private executor access if a public routing API appears.
```

The worker must audit the implementation before setting `usesUndocumentedApis` to false. Undocumented behavior counts as an internal dependency, even without a private import. Tests passing never justifies changing this declaration. The main reviewer must still consider indirect behavioral effects for extensions marked false.

## Failure handling and limits

State is in `~/.local/state/pi-evergreen/state.json`. Per-run test results, changelogs, model responses and errors are under `runs/`. Working copies are under `workspaces/<pi-version>/<repo>/`; they preserve interrupted worker edits for the next attempt. Canonical extension checkouts only receive fast-forward pulls. Release commits reach them on the next synchronization. Old working copies and logs are retained for inspection and can consume disk space.

Never delete a release journal blindly after a publication failure. Fix credentials or registry access and rerun. If a pending repository is archived, deleted, transferred, or changes its default branch, the runner stops rather than publishing stale work. Inspect that journal and deliberately cancel or resolve it. If a worker violates package identity or Git invariants, inspect its working copy before clearing the associated workspace record. The runner does not repair such violations by discarding work.

Workers and repository tests execute as your user. A prompt, working directory, `--no-approve`, and separate Git working copy are **not a security sandbox**. They can access that user's files and credentials. Use a dedicated maintenance account or container, restricted credentials and trusted repositories. The parent validates publication identity and refuses protected instruction files or credential filenames, but cannot prevent every bad model action or malicious test. This is autonomous publishing, not a guarantee of semantic correctness.

Command deadlines kill the ordinary process group and close captured pipes. The user service uses `KillMode=control-group` to contain descendants on shutdown. A deliberately detached process may outlive an individual command timeout until service shutdown. Use OS isolation for stronger restrictions. Dependency install scripts are disabled; a project that needs generated install artifacts must generate them through its explicit test/build commands.

## Development

```sh
npm test
npm run check
npm pack --dry-run
```

Tests use isolated fixtures under this repository's ignored `tmp/` directory. They cover scheduling inputs, update fallback, paginated active discovery, version gating, SDK test setup, relevance decisions, first-run knowledge, publication order and retry recovery. They do not call real models or publish packages.
