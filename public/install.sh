#!/usr/bin/env sh
# wraith installer
# Usage: curl -fsSL https://wraith.cx/install.sh | sh
set -eu

REPO="${WRAITH_RELEASE_REPO:-bobisme/wraith-releases}"
BIN_NAME="wraith"
INSTALL_DIR="${WRAITH_INSTALL_DIR:-}"
VERSION="${WRAITH_VERSION:-}"
RELEASE_BASE_URL="${WRAITH_RELEASE_BASE_URL:-}"

log()  { printf "%s\n" "$*"; }
die()  { printf "error: %s\n" "$*" >&2; exit 1; }

# --- detect OS + arch ---
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)

case "$os" in
    darwin) os_target="apple-darwin" ;;
    linux)  os_target="unknown-linux-gnu" ;;
    *)      die "unsupported OS: $os" ;;
esac

case "$arch" in
    x86_64|amd64)  arch_target="x86_64" ;;
    arm64|aarch64) arch_target="aarch64" ;;
    *)             die "unsupported CPU architecture: $arch" ;;
esac

target="${arch_target}-${os_target}"

# --- choose install dir ---
if [ -z "$INSTALL_DIR" ]; then
    if [ -w "/usr/local/bin" ] 2>/dev/null; then
        INSTALL_DIR="/usr/local/bin"
    else
        INSTALL_DIR="$HOME/.local/bin"
    fi
fi
mkdir -p "$INSTALL_DIR"

# --- resolve release tag ---
if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fL --retry 3 --retry-delay 1 -sS "$1"; }
else
    die "curl is required"
fi

if [ -n "$VERSION" ]; then
    log "Using wraith ${VERSION#v}..."
    version="${VERSION#v}"
    tag="v$version"
else
    log "Fetching latest release..."
    tag=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | \
        sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
    [ -n "$tag" ] || die "could not resolve latest release tag"
    version="${tag#v}"
fi

# --- download + verify ---
archive="wraith-${version}-${target}.tar.gz"
if [ -n "$RELEASE_BASE_URL" ]; then
    url="${RELEASE_BASE_URL%/}/${archive}"
else
    url="https://github.com/$REPO/releases/download/${tag}/${archive}"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "Downloading $archive..."
fetch "$url" > "$tmp/$archive" || die "download failed for $target. This release may not include your platform: $url"

log "Verifying checksum..."
fetch "$url.sha256" > "$tmp/$archive.sha256" || die "checksum download failed"

expected=$(awk '{print $1}' "$tmp/$archive.sha256")
if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
else
    die "neither shasum nor sha256sum is available for checksum verification"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch: expected $expected got $actual"

# --- extract + install ---
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/$BIN_NAME" ] || die "archive did not contain $BIN_NAME at the root"
install -m 0755 "$tmp/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME" 2>/dev/null || \
    cp "$tmp/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME" && chmod 0755 "$INSTALL_DIR/$BIN_NAME"

log ""
log "Installed $BIN_NAME $tag to $INSTALL_DIR/$BIN_NAME"

# --- PATH check ---
case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        log ""
        log "Warning: $INSTALL_DIR is not on your PATH."
        log "Add this to your shell config:"
        log "    export PATH=\"$INSTALL_DIR:\$PATH\""
        ;;
esac

log ""
log "Next: wraith init myapi --base-url https://api.example.com"
