---
title: Installation
description: How to get a wraith binary
---

## Install with curl

```sh
curl -fsSL https://wraith.cx/install.sh | sh
```

The installer downloads the latest binary from
[`bobisme/wraith-releases`](https://github.com/bobisme/wraith-releases),
verifies the SHA-256 checksum, and installs `wraith` into `/usr/local/bin` when
writable or `~/.local/bin` otherwise.

Install into a custom directory:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_INSTALL_DIR="$HOME/bin" sh
```

Pin a specific version:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_VERSION=0.5.2 sh
```

Current prebuilt targets:

- `x86_64-unknown-linux-gnu`
- `aarch64-apple-darwin`

Linux ARM64 and Intel macOS installers will be enabled after release runners for
those targets are validated. Unsupported platforms fail before installation.

## Build from source

Wraith is a single Rust binary with no runtime dependencies.

```sh
git clone <private-repo-url> wraith
cd wraith
cargo build --release
./target/release/wraith --version
```

Move the binary somewhere on your `PATH`:

```sh
install -m 0755 target/release/wraith ~/.local/bin/wraith
```

Requirements for building:

- Rust 1.85+ (install via [rustup](https://rustup.rs/))
- A C toolchain

## Verify

```sh
wraith --version
```

## Runtime requirements

- **OS**: macOS ARM64 or Linux x86_64 for prebuilt binaries; macOS x86_64 and Linux ARM64 from source for now
- **Runtime dependencies**: none — wraith is a single static binary
- **Recording**: access to the upstream API you want to twin
- **LLM-assisted repair** (optional): local model via ollama, or cloud provider API key

## Next steps

```sh
wraith init myapi --base-url https://api.example.com
```

See the [Quickstart](/quickstart/) to build your first twin in 5 minutes.
