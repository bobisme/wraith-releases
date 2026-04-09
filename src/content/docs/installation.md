---
title: Installation
description: Install wraith via Homebrew, curl, or manual download
---

## Homebrew (macOS / Linux)

```sh
brew install bobisme/tap/wraith
```

## curl (macOS / Linux)

```sh
curl -fsSL https://wraith.cx/install.sh | sh
```

The installer detects your OS and architecture, downloads the latest release from GitHub, verifies the SHA-256 checksum, and installs to `/usr/local/bin` (or `~/.local/bin` if `/usr/local/bin` is not writable).

Override the install directory:

```sh
WRAITH_INSTALL_DIR=~/bin curl -fsSL https://wraith.cx/install.sh | sh
```

## Manual download

Download the latest release archive from [GitHub Releases](https://github.com/bobisme/wraith-releases/releases).

Available targets:
- `wraith-<version>-x86_64-unknown-linux-gnu.tar.gz`
- `wraith-<version>-aarch64-unknown-linux-gnu.tar.gz`
- `wraith-<version>-x86_64-apple-darwin.tar.gz`
- `wraith-<version>-aarch64-apple-darwin.tar.gz`

Extract and move the binary:

```sh
tar -xzf wraith-*.tar.gz
sudo install -m 0755 wraith /usr/local/bin/wraith
```

## Verify

```sh
wraith --version
```

## Requirements

- **OS**: macOS (x86_64, ARM64) or Linux (x86_64, ARM64)
- **Runtime dependencies**: none -- wraith is a single static binary
- **Recording**: access to the upstream API you want to twin
- **LLM-assisted repair** (optional): local model via ollama, or cloud provider API key

## Next steps

```sh
wraith init myapi --base-url https://api.example.com
```

See the [Quickstart](/quickstart/) to build your first twin in 5 minutes.
