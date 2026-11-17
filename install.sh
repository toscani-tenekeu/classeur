#!/usr/bin/env bash
# Installs or upgrades Classeur on a Linux server.
#
#   sudo bash install.sh
#
# Works on Debian, Ubuntu, Linux Mint, RHEL, Rocky, AlmaLinux, CentOS Stream,
# Fedora, Oracle Linux, Amazon Linux, openSUSE, Arch, Manjaro and Alpine,
# on x86-64 and ARM64.
#
# Optional settings, given as environment variables:
#   CLASSEUR_DIR   where to install            (default /opt/classeur)
#   CLASSEUR_HOST  address to listen on        (default 0.0.0.0)
#   CLASSEUR_PORT  port to listen on           (default 7080)
#   CLASSEUR_URL   public address, if you put Classeur behind a domain name
#   CLASSEUR_REPO  where to download Classeur from (a git URL or a local copy)
set -euo pipefail

REPO="${CLASSEUR_REPO:-https://github.com/toscani-tenekeu/classeur.git}"
DIR="${CLASSEUR_DIR:-/opt/classeur}"
HOST="${CLASSEUR_HOST:-0.0.0.0}"
PORT="${CLASSEUR_PORT:-7080}"
URL="${CLASSEUR_URL:-}"

say() { printf '\n==> %s\n' "$1"; }
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script as root (sudo bash install.sh)."
[ "$(uname -s)" = "Linux" ] || die "Classeur runs on Linux only."
case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "Classeur needs a 64-bit x86 or ARM processor; this one is $(uname -m)." ;;
esac

# ---- Packages -------------------------------------------------------------------
# Required: git and curl to download, and the archive tools the app uses.
# 7-Zip and zstd are optional; their absence only disables .7z, .rar and .zst.

install_packages() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q git curl ca-certificates tar gzip xz-utils bzip2 zip unzip
    apt-get install -y -q 7zip >/dev/null 2>&1 || apt-get install -y -q p7zip-full >/dev/null 2>&1 || true
    apt-get install -y -q zstd >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    local pm
    pm="$(command -v dnf || command -v yum)"
    # Many images ship curl-minimal, which conflicts with the full curl package; either works.
    command -v curl >/dev/null || "$pm" install -y -q curl
    "$pm" install -y -q git ca-certificates tar gzip xz bzip2 zip unzip which
    "$pm" install -y -q 7zip >/dev/null 2>&1 || "$pm" install -y -q p7zip p7zip-plugins >/dev/null 2>&1 || true
    "$pm" install -y -q zstd >/dev/null 2>&1 || true
  elif command -v zypper >/dev/null; then
    zypper --non-interactive --quiet refresh
    zypper --non-interactive --quiet install git curl ca-certificates tar gzip xz bzip2 zip unzip which
    zypper --non-interactive --quiet install 7zip >/dev/null 2>&1 || zypper --non-interactive --quiet install p7zip-full >/dev/null 2>&1 || true
    zypper --non-interactive --quiet install zstd >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null; then
    # Arch does not support partial upgrades, so the package database is synced with a full upgrade.
    pacman -Syu --noconfirm --needed git curl ca-certificates tar gzip xz bzip2 zip unzip which
    pacman -S --noconfirm --needed 7zip >/dev/null 2>&1 || pacman -S --noconfirm --needed p7zip >/dev/null 2>&1 || true
    pacman -S --noconfirm --needed zstd >/dev/null 2>&1 || true
  elif command -v apk >/dev/null; then
    # GNU tar instead of BusyBox's, and the C++ runtime Bun needs on musl.
    apk add --no-cache bash git curl ca-certificates tar gzip xz bzip2 zip unzip coreutils libstdc++ libgcc
    apk add --no-cache 7zip >/dev/null 2>&1 || apk add --no-cache p7zip >/dev/null 2>&1 || true
    apk add --no-cache zstd >/dev/null 2>&1 || true
  else
    die "no supported package manager found (apt, dnf, yum, zypper, pacman or apk)."
  fi
}

say "Installing required packages"
install_packages

# ---- Bun ----------------------------------------------------------------------------

BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x /usr/local/bin/bun ]; then BUN=/usr/local/bin/bun; fi
if [ -z "$BUN" ]; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
  BUN=/usr/local/bin/bun
fi
"$BUN" --version >/dev/null || die "Bun does not run on this system. It needs Linux 5.1 or newer (this one is $(uname -r))."

# ---- Classeur --------------------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading Classeur to $DIR"
  git clone --depth 50 "$REPO" "$DIR"
fi

say "Building the interface"
cd "$DIR"
"$BUN" run build

# ---- Service ---------------------------------------------------------------------------

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
  say "Setting up the systemd service"
  cat > /etc/systemd/system/classeur.service <<UNIT
[Unit]
Description=Classeur file manager
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$BUN server/index.ts
Environment=CLASSEUR_HOST=$HOST
Environment=CLASSEUR_PORT=$PORT
Environment=CLASSEUR_URL=$URL
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --quiet classeur
  systemctl restart classeur
  MANAGER=systemd
elif command -v rc-service >/dev/null && [ -d /etc/init.d ]; then
  say "Setting up the OpenRC service"
  cat > /etc/init.d/classeur <<RC
#!/sbin/openrc-run
name="Classeur"
description="Classeur file manager"
command="$BUN"
command_args="server/index.ts"
command_background=true
directory="$DIR"
pidfile="/run/classeur.pid"
output_log="/var/log/classeur.log"
error_log="/var/log/classeur.log"
export CLASSEUR_HOST="$HOST" CLASSEUR_PORT="$PORT" CLASSEUR_URL="$URL"
supervisor=supervise-daemon
respawn_delay=2

depend() {
  need net
}
RC
  chmod +x /etc/init.d/classeur
  rc-update add classeur default >/dev/null
  rc-service classeur restart >/dev/null 2>&1 || rc-service classeur start
  MANAGER=openrc
else
  MANAGER=none
fi

if [ "$MANAGER" = none ]; then
  cat <<NOTE

No service manager was found (systemd or OpenRC), so Classeur was not set to
start on its own. Start it with:

  cd $DIR && CLASSEUR_HOST=$HOST CLASSEUR_PORT=$PORT CLASSEUR_URL=$URL $BUN server/index.ts

NOTE
  exit 0
fi

for _ in $(seq 1 30); do
  [ -f "$DIR/data/first-run.txt" ] && break
  sleep 0.5
done

echo
if [ -f "$DIR/data/first-run.txt" ]; then
  cat "$DIR/data/first-run.txt"
else
  echo "Classeur is running on port $PORT. Sign in with your existing password."
fi

if [ "$HOST" != "127.0.0.1" ] && command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  echo "firewalld is active. To reach Classeur from outside, open the port:"
  echo "  firewall-cmd --permanent --add-port=$PORT/tcp && firewall-cmd --reload"
fi
