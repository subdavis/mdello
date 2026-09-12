#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
plist_template="$script_dir/com.mdello.companion.plist"
plist_destination="$HOME/Library/LaunchAgents/com.mdello.companion.plist"
mise_bin=$(command -v mise || true)

if [ -z "$mise_bin" ]; then
  echo "mise not found in PATH" >&2
  exit 1
fi

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[|&\\]/\\&/g'
}

mkdir -p "$HOME/.mdello" "$(dirname "$plist_destination")"
# Replace an old repository symlink before redirecting, so the template is never truncated.
rm -f "$plist_destination"
sed \
  -e "s|__MISE_BIN__|$(escape_sed_replacement "$mise_bin")|g" \
  -e "s|__MDELLO_ROOT__|$(escape_sed_replacement "$repo_root")|g" \
  -e "s|__HOME__|$(escape_sed_replacement "$HOME")|g" \
  "$plist_template" >"$plist_destination"

user_domain="gui/$(id -u)"
launchctl bootout "$user_domain" "$plist_destination" 2>/dev/null || true
launchctl bootstrap "$user_domain" "$plist_destination"
launchctl kickstart -k "$user_domain/com.mdello.companion"

echo "Installed and started $plist_destination"
