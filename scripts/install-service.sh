#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
# systemd does not read interactive shell startup files. mise shims must be first.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
node src/cli.js --check-config
npm ci --ignore-scripts
mkdir -p "$HOME/.config/systemd/user"
# systemd paths escape spaces with quotes. Reject characters with special unit semantics.
if [[ "$root$HOME" == *'"'* || "$root$HOME" == *'%'* || "$root$HOME" == *$'\n'* || "$root$HOME" == *'\\'* ]]; then
  echo 'Unsupported characters in installation path' >&2; exit 1
fi
cat > "$HOME/.config/systemd/user/pi-evergreen.service" <<UNIT
[Unit]
Description=Nightly Pi extension maintenance
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$root
Environment="PATH=$PATH"
EnvironmentFile=-%h/.config/pi-evergreen/environment
ExecStart=/usr/bin/env node "$root/src/cli.js"
Restart=on-failure
RestartSec=30
KillMode=control-group
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now pi-evergreen.service
systemctl --user status pi-evergreen.service --no-pager
