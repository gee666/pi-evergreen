# pi-evergreen

Nightly maintenance for the owner's Pi extensions. It updates Pi through mise
and updates installed extensions, syncs active `pi-*` GitHub repos, and initializes
managed extensions with intent-focused tests and EVERGREEN.md.

The first run records a baseline Pi version. Later runs test extensions when Pi
changes or monthly dependencies are due. One master agent selects work and
launches one worker per affected extension. Workers test, commit, patch, push,
and publish packages that are public and already on npm.

## Configure

Requires Node 26, npm, mise-managed Pi, git, gh with GitHub access, and the
pi-subagent extension. Pi must already be logged in for the configured models.

Copy `.env.example` to `.env` and set the extensions directory, GitHub owner,
master/worker model, junior model, e2e model, and NPM_TOKEN. Models use
`provider/model:thinking`. The run passes a temporary npm configuration to agents
and removes it when finished.

Repos qualify through a Pi dependency, a `pi` package.json field, or the
`pi-package` keyword. Initialization discards uncommitted checkout changes.
EVERGREEN.md and `test:evergreen` are the ongoing extension contract.

## Install

```sh
bash scripts/install.sh
```

The installer runs `npm ci` and installs a persistent user timer for 02:00 local
time. It removes the old service and repair service and enables lingering. It
does not start the service directly. The lead starts the first run.

## Run manually

```sh
npm start
```

State is in `.state/state.json`. Each `.state/runs/<timestamp>/` contains agent
logs, test logs and summary, the manifest, and the master's report when those
steps run. Progress goes to stdout for journald. A failed master leaves state
unchanged so the next nightly run tries again.

```sh
npm run check
npm test
```
