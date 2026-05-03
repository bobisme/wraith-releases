#!/usr/bin/env sh
# wraith installer
# Usage: curl -fsSL https://wraith.cx/install.sh | sh
set -eu

REPO="${WRAITH_RELEASE_REPO:-bobisme/wraith-releases}"
BIN_NAME="wraith"
INSTALL_DIR="${WRAITH_INSTALL_DIR:-}"
VERSION="${WRAITH_VERSION:-}"
RELEASE_BASE_URL="${WRAITH_RELEASE_BASE_URL:-}"

log() {
    printf "%s\n" "$*" >&2
}

die() {
    printf "error: %s\n" "$*" >&2
    exit 1
}

# Fetch a URL with retries so transient network failures do not abort installs.
fetch() {
    curl -fL --retry 3 --retry-delay 1 -sS "$1"
}

# Ensure the local machine has the external tools this installer relies on.
require_tools() {
    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v tar >/dev/null 2>&1 || die "tar is required"
    command -v awk >/dev/null 2>&1 || die "awk is required"
    command -v uname >/dev/null 2>&1 || die "uname is required"

    if ! command -v install >/dev/null 2>&1 && ! command -v cp >/dev/null 2>&1; then
        die "install or cp is required"
    fi
}

# Convert uname output into the release target suffix used by artifact names.
detect_target() {
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

    printf "%s-%s\n" "$arch_target" "$os_target"
}

# Pick a writable install directory, preferring /usr/local/bin when possible.
resolve_install_dir() {
    if [ -n "$INSTALL_DIR" ]; then
        printf "%s\n" "$INSTALL_DIR"
        return
    fi

    if [ -w "/usr/local/bin" ] 2>/dev/null; then
        printf "%s\n" "/usr/local/bin"
    else
        printf "%s\n" "$HOME/.local/bin"
    fi
}

# Choose the release tag and version. WRAITH_VERSION may be "0.5.2" or "v0.5.2".
resolve_release() {
    if [ -n "$VERSION" ]; then
        version="${VERSION#v}"
        log "Using wraith $version..."
        printf "v%s %s\n" "$version" "$version"
        return
    fi

    log "Fetching latest release..."
    tag=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | \
        sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)

    [ -n "$tag" ] || die "could not resolve latest release tag"
    printf "%s %s\n" "$tag" "${tag#v}"
}

# Build the release asset URL, optionally using WRAITH_RELEASE_BASE_URL for tests.
asset_url() {
    tag="$1"
    archive="$2"

    if [ -n "$RELEASE_BASE_URL" ]; then
        printf "%s/%s\n" "${RELEASE_BASE_URL%/}" "$archive"
    else
        printf "https://github.com/%s/releases/download/%s/%s\n" "$REPO" "$tag" "$archive"
    fi
}

# Download the archive and its checksum into the temporary work directory.
download_assets() {
    url="$1"
    archive="$2"
    tmp="$3"
    target="$4"

    log "Downloading $archive..."
    fetch "$url" > "$tmp/$archive" || \
        die "download failed for $target. This release may not include your platform: $url"

    log "Downloading checksum..."
    fetch "$url.sha256" > "$tmp/$archive.sha256" || die "checksum download failed: $url.sha256"
}

# Verify the downloaded archive exactly matches the published SHA-256 checksum.
verify_checksum() {
    archive_path="$1"
    checksum_path="$2"

    expected=$(awk '{print $1}' "$checksum_path")
    [ -n "$expected" ] || die "checksum file was empty or invalid"

    if command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
    elif command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$archive_path" | awk '{print $1}')
    else
        die "neither shasum nor sha256sum is available for checksum verification"
    fi

    [ "$expected" = "$actual" ] || die "checksum mismatch: expected $expected got $actual"
}

# Extract the archive and install the wraith binary into the requested directory.
install_binary() {
    archive_path="$1"
    tmp="$2"
    install_dir="$3"

    mkdir -p "$install_dir"
    tar -xzf "$archive_path" -C "$tmp"

    [ -f "$tmp/$BIN_NAME" ] || die "archive did not contain $BIN_NAME at the root"

    if command -v install >/dev/null 2>&1; then
        install -m 0755 "$tmp/$BIN_NAME" "$install_dir/$BIN_NAME" 2>/dev/null || {
            cp "$tmp/$BIN_NAME" "$install_dir/$BIN_NAME"
            chmod 0755 "$install_dir/$BIN_NAME"
        }
    else
        cp "$tmp/$BIN_NAME" "$install_dir/$BIN_NAME"
        chmod 0755 "$install_dir/$BIN_NAME"
    fi
}

# Warn when the selected install directory is not currently visible on PATH.
print_path_hint() {
    install_dir="$1"

    case ":$PATH:" in
        *":$install_dir:"*) ;;
        *)
            log ""
            log "Warning: $install_dir is not on your PATH."
            log "Add this to your shell config:"
            log "    export PATH=\"$install_dir:\$PATH\""
            ;;
    esac
}

# Run the installer from environment parsing through verified installation.
main() {
    require_tools

    target=$(detect_target)
    install_dir=$(resolve_install_dir)
    release=$(resolve_release)
    tag=$(printf "%s" "$release" | awk '{print $1}')
    version=$(printf "%s" "$release" | awk '{print $2}')
    archive="$BIN_NAME-$version-$target.tar.gz"
    url=$(asset_url "$tag" "$archive")
    tmp=$(mktemp -d)

    trap 'rm -rf "$tmp"' EXIT

    download_assets "$url" "$archive" "$tmp" "$target"

    log "Verifying checksum..."
    verify_checksum "$tmp/$archive" "$tmp/$archive.sha256"

    install_binary "$tmp/$archive" "$tmp" "$install_dir"

    log ""
    log "Installed $BIN_NAME $tag to $install_dir/$BIN_NAME"
    print_path_hint "$install_dir"

    log ""
    log "Next: wraith init myapi --base-url https://api.example.com"
}

main "$@"
