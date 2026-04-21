---
title: Installation
description: How to get a wraith binary
---

:::note[Private beta]
Wraith is in private beta. Packaged installers are not yet published. To get
a binary, contact the maintainer directly or build from source.
:::

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
- A C toolchain (for `zstd` and `ring`)

## Coming soon

These channels are planned for the public release and are **not live yet**:

- **Homebrew tap** — `brew install bobisme/tap/wraith`
- **curl installer** — `curl -fsSL https://wraith.cx/install.sh | sh`
- **GitHub Releases** — prebuilt tarballs for Linux and macOS (x86_64, aarch64)

If you land on this page from an external link expecting any of the above to
work, please [open an issue](https://github.com/bobisme/wraith-releases/issues)
so we can fix the link.

## Verify

```sh
wraith --version
```

## Runtime requirements

- **OS**: macOS (x86_64, ARM64) or Linux (x86_64, ARM64)
- **Runtime dependencies**: none — wraith is a single static binary
- **Recording**: access to the upstream API you want to twin
- **LLM-assisted repair** (optional): local model via ollama, or cloud provider API key

## Next steps

```sh
wraith init myapi --base-url https://api.example.com
```

See the [Quickstart](/quickstart/) to build your first twin in 5 minutes.
