#!/bin/sh
# Installs mshape, monkeyshape's CLI, once per machine:
#
#   curl -fsSL https://github.com/clinsky/monkeyshape/releases/latest/download/install.sh | sh
#
# It downloads the binary for this machine and the release's SHA256SUMS, refuses a binary
# that doesn't match, and puts `mshape` in ${MSHAPE_INSTALL_DIR:-$HOME/.local/bin} with the
# SHA256SUMS digest beside it (mshape.sums), which a repo's pin is checked against. Inside a
# repo, the installed mshape runs the version the repo's shape.toml pins.
#
#   MSHAPE_VERSION        a version to install (1.2.3), else the latest release
#   MSHAPE_INSTALL_DIR    where to put mshape, else $HOME/.local/bin
#   MSHAPE_RELEASES_URL   where releases are, else GitHub's (a mirror)
set -eu

releases="${MSHAPE_RELEASES_URL:-https://github.com/clinsky/monkeyshape/releases}"
releases="${releases%/}"
dir="${MSHAPE_INSTALL_DIR:-${HOME:?set HOME or MSHAPE_INSTALL_DIR}/.local/bin}"
supported="linux-x64, linux-arm64, darwin-arm64"

refuse() {
  echo "mshape install: $*" >&2
  exit 1
}

os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64 | Linux-amd64) platform=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  Darwin-arm64 | Darwin-aarch64) platform=darwin-arm64 ;;
  *) refuse "$os-$arch is not a platform mshape supports: it runs on $supported" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  refuse "neither curl nor wget is installed: install one, then run this again"
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  refuse "neither sha256sum nor shasum is installed, so a download can't be verified: install one, then run this again"
fi

if [ -n "${MSHAPE_VERSION:-}" ]; then
  base="$releases/download/v${MSHAPE_VERSION#v}"
else
  base="$releases/latest/download"
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/mshape-install-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

asset="mshape-$platform"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || refuse "could not download $base/SHA256SUMS"
fetch "$base/$asset" "$tmp/$asset" || refuse "could not download $base/$asset"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || refuse "$base/SHA256SUMS lists no $asset"
got="$(digest "$tmp/$asset")"
if [ "$got" != "$expected" ]; then
  rm -f "$tmp/$asset"
  refuse "$base/$asset has sha256 $got, but SHA256SUMS lists $expected: deleted, nothing installed. Retry; if it persists, the download was tampered with"
fi

mkdir -p "$dir"
chmod 755 "$tmp/$asset"
# The binary, then its record, each renamed into place: a run in between never trusts a
# binary its record doesn't vouch for.
mv -f "$tmp/$asset" "$dir/mshape.partial"
mv -f "$dir/mshape.partial" "$dir/mshape"
digest "$tmp/SHA256SUMS" > "$dir/mshape.sums.partial"
mv -f "$dir/mshape.sums.partial" "$dir/mshape.sums"

version="$(MSHAPE_LAUNCHED=install "$dir/mshape" --version)" || refuse "$dir/mshape was installed but doesn't run"
echo "installed mshape $version at $dir/mshape (verified against SHA256SUMS)"
case ":${PATH}:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH; add it, e.g. to ~/.profile: export PATH=\"$dir:\$PATH\"" ;;
esac
