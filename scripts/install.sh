#!/usr/bin/env bash
set -euo pipefail

project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
units="$HOME/.config/systemd/user"
mkdir -p "$units"

systemctl --user disable --now pi-evergreen.service pi-evergreen-repair.service 2>/dev/null || true
rm -f "$units/pi-evergreen.service" "$units/pi-evergreen-repair.service"

cat > "$units/pi-evergreen.service" <<UNIT
[Unit]
Description=Keep Pi extensions evergreen

[Service]
Type=oneshot
WorkingDirectory="$project"
Environment="PATH=$HOME/.local/share/mise/shims:$PATH"
ExecStart=node --env-file=.env src/run.ts
TimeoutStartSec=infinity
UNIT

cat > "$units/pi-evergreen.timer" <<'UNIT'
[Unit]
Description=Run Pi Evergreen nightly

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cd "$project"
npm ci
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable pi-evergreen.timer
printf 'Timer enabled. Service was not started by this installer.\n'
