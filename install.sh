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

echo "hara: downloading $asset …"
if ! curl -fsSL "$url" -o "$dest/hara"; then
  echo "hara: download failed ($url). The release may not have this target yet — try: npm i -g @nanhara/hara" >&2
  exit 1
fi
chmod +x "$dest/hara"
echo "hara: installed to $dest/hara"
case ":$PATH:" in
  *":$dest:"*) "$dest/hara" --version ;;
  *) echo "hara: add it to your PATH →  export PATH=\"$dest:\$PATH\"" ;;
esac
