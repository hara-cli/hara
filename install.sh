#!/bin/sh
# Install the hara standalone binary (no Node required). Usage:
#   curl -fsSL https://raw.githubusercontent.com/hara-cli/hara/main/install.sh | sh
# Override the install dir with HARA_INSTALL=/usr/local/bin.
set -e
REPO="hara-cli/hara"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "hara: unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin | linux) ;;
  *) echo "hara: unsupported OS: $os (use npm i -g @nanhara/hara instead)" >&2; exit 1 ;;
esac

asset="hara-$os-$arch"
url="https://github.com/$REPO/releases/latest/download/$asset"
dest="${HARA_INSTALL:-$HOME/.local/bin}"
mkdir -p "$dest"
tmp=$(mktemp "$dest/.hara-download.XXXXXX")
cleanup() { rm -f "$tmp"; }
trap cleanup 0
trap 'exit 1' 1 2 15

echo "hara: downloading $asset …"
if ! curl -fsSL "$url" -o "$tmp"; then
  echo "hara: download failed ($url). The release may not have this target yet — try: npm i -g @nanhara/hara" >&2
  exit 1
fi
chmod +x "$tmp"
if ! downloaded_version=$("$tmp" --version 2>/dev/null); then
  echo "hara: downloaded binary failed its startup check; existing installation was not changed" >&2
  exit 1
fi
case "$downloaded_version" in
  "" | *[!0-9.]* | .* | *. | *..* | *.*.*.*)
    echo "hara: downloaded binary returned an invalid version; existing installation was not changed" >&2
    exit 1
    ;;
  *.*.*) ;;
  *) echo "hara: downloaded binary returned an invalid version; existing installation was not changed" >&2; exit 1 ;;
esac
# The temporary file lives beside the destination, so this is an atomic same-filesystem replacement.
# A failed/partial transfer never truncates the Hara binary the user is currently relying on.
mv -f "$tmp" "$dest/hara"
trap - 0 1 2 15
echo "hara: installed to $dest/hara"
case ":$PATH:" in
  *":$dest:"*) "$dest/hara" --version ;;
  *) echo "hara: add it to your PATH →  export PATH=\"$dest:\$PATH\"" ;;
esac
