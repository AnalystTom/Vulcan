#!/usr/bin/env bash
# Run on the chosen Linux machine after installing a built Vulcan package.
# Usage: install-bot-host.sh /absolute/package/path [service-name] [port]
set -euo pipefail
package_dir=${1:?Pass the absolute installed Vulcan package directory}
service_name=${2:-vulcan-bots}
bot_port=${3:-3774}
[[ "$package_dir" =~ ^/[a-zA-Z0-9_./-]+$ && "$service_name" =~ ^[a-zA-Z0-9_-]+$ && "$bot_port" =~ ^[0-9]+$ ]] || { echo 'Invalid path, service name or port.' >&2; exit 1; }
(( bot_port > 1024 && bot_port < 65536 )) || exit 1
[[ -f "$package_dir/dist/index.mjs" ]] || { echo 'Build and install the Vulcan package first.' >&2; exit 1; }
node_bin=$(command -v node)
config_dir="$HOME/.config/$service_name"
unit_path="$HOME/.config/systemd/user/$service_name.service"
[[ ! -e "$unit_path" ]] || { echo "Service already exists: $service_name. Review its configuration before updating it." >&2; exit 1; }
if ss -ltnH | awk '{print $4}' | grep -Eq ":${bot_port}$"; then echo 'Port is already occupied.' >&2; exit 1; fi
umask 077
mkdir -p "$config_dir" "$HOME/.config/systemd/user"
[[ -e "$config_dir/environment" ]] || {
  printf 'VULCAN_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$config_dir/environment"
}
cat > "$unit_path" <<UNIT
[Unit]
Description=Vulcan persistent bot host
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$package_dir
Environment="PATH=$PATH"
EnvironmentFile=$config_dir/environment
ExecStart=$node_bin $package_dir/dist/index.mjs --host 127.0.0.1 --port $bot_port --home-dir $HOME/.local/share/$service_name/state --no-browser
Restart=always
RestartSec=5
TimeoutStopSec=60
UMask=0077
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$service_name"
systemctl --user is-active "$service_name"
echo "Host listens on 127.0.0.1:$bot_port. Connect through a tailnet-only HTTPS proxy."
echo "Private provider configuration: $config_dir/environment"
echo 'Verify loginctl show-user "$USER" -p Linger reports yes before relying on logout persistence.'
