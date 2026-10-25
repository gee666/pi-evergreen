#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --deploy-from-repair ) ]]; then
  echo 'Usage: scripts/install-service.sh [--deploy-from-repair]' >&2; exit 1
fi
# systemd does not read interactive shell startup files. mise shims must be first.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
node src/cli.js --check-config
npm ci --ignore-scripts
mkdir -p "$HOME/.config/systemd/user"
# Reject characters with special unit semantics.
if [[ "$root$HOME" == *'"'* || "$root$HOME" == *'%'* || "$root$HOME" == *$'\n'* || "$root$HOME" == *'\\'* ]]; then
  echo 'Unsupported characters in installation path' >&2; exit 1
fi
cat > "$HOME/.config/systemd/user/pi-evergreen.service" <<UNIT
[Unit]
Description=Nightly Pi extension maintenance
After=network-online.target
Wants=network-online.target
OnFailure=pi-evergreen-repair.service
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$root
Environment="PATH=$PATH"
ExecStart=/usr/bin/env node "$root/src/cli.js"
Restart=no
SuccessExitStatus=130 143
KillMode=control-group
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
UNIT
cat > "$HOME/.config/systemd/user/pi-evergreen-repair.service" <<UNIT
[Unit]
Description=Independent Pi Evergreen repair supervisor
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$root
Environment="PATH=$PATH"
Environment=PI_EVERGREEN_REPAIR_ACTIVE=1
ExecStart=/usr/bin/env node "$root/scripts/repair.mjs"
Restart=on-failure
RestartSec=60
KillMode=control-group
TimeoutStopSec=20
UMask=0077
UNIT
systemctl --user daemon-reload
systemctl --user enable pi-evergreen.service
if [[ "${1:-}" == --deploy-from-repair ]]; then
  systemctl --user reset-failed pi-evergreen.service || true
  systemctl --user restart pi-evergreen.service
else
  systemctl --user restart pi-evergreen.service
fi
systemctl --user status pi-evergreen.service --no-pager
