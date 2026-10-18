#!/bin/sh
# Installs the `whiphand` CLI and terminal UI from a GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/PlainBytes/whip-hand/main/scripts/install/install.sh | sh
#
# It downloads the static Linux binary and the release's SHA256SUMS, refuses a
# binary whose checksum does not match, and puts it in ~/.local/bin.
#
#   WHIPHAND_VERSION       a release such as 0.5.1 (default: the latest)
#   WHIPHAND_INSTALL_DIR   where to put `whiphand` (default: ~/.local/bin)
#   WHIPHAND_RELEASES_URL  the releases' download base (tests point it elsewhere)
set -eu

ASSET=whiphand-linux-x86_64

say() { printf '%s\n' "$*"; }
fail() { printf 'whiphand install: %s\n' "$*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
[ "$os" = Linux ] || fail "this script installs the Linux build; this is $os (on Windows use install.ps1)"
case "$arch" in
  x86_64 | amd64) ;;
  *) fail "only x86_64 is built; this machine is $arch" ;;
esac

base=${WHIPHAND_RELEASES_URL:-https://github.com/PlainBytes/whip-hand/releases}
if [ -n "${WHIPHAND_VERSION:-}" ]; then
  url="$base/download/v${WHIPHAND_VERSION#v}"
else
  url="$base/latest/download"
fi
dir=${WHIPHAND_INSTALL_DIR:-$HOME/.local/bin}

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "needs curl or wget"
fi
command -v sha256sum >/dev/null 2>&1 || fail "needs sha256sum"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $url/$ASSET"
fetch "$url/$ASSET" "$tmp/$ASSET" || fail "could not download $url/$ASSET"
fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $url/SHA256SUMS"

grep " $ASSET\$" "$tmp/SHA256SUMS" > "$tmp/expected" || fail "SHA256SUMS lists no $ASSET"
(cd "$tmp" && sha256sum -c --status expected) || fail "checksum mismatch for $ASSET; nothing installed"

# Copied in beside the target, then renamed over it: a rename replaces a
# `whiphand` that is running, where writing into it would fail as busy.
mkdir -p "$dir"
cp "$tmp/$ASSET" "$dir/.whiphand.new"
chmod 755 "$dir/.whiphand.new"
mv -f "$dir/.whiphand.new" "$dir/whiphand"
say "installed $dir/whiphand ($("$dir/whiphand" --version))"

case ":$PATH:" in
  *":$dir:"*) say "run 'whiphand' for the terminal UI, 'whiphand --help' for the commands" ;;
  *) say "$dir is not on your PATH; add it (e.g. in ~/.profile) to run 'whiphand'" ;;
esac
