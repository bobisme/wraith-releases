---
title: Install the Wraith API twin CLI
description: Install Wraith from the checksum-verified release script, pin versions, choose a target directory, troubleshoot PATH, or build from source.
---

## Recommended install

```sh
curl -fsSL https://wraith.cx/install.sh | sh
```

The installer downloads the latest public binary from
[`bobisme/wraith-releases`](https://github.com/bobisme/wraith-releases),
verifies the SHA-256 checksum, and installs `wraith` into `/usr/local/bin` when
writable or `~/.local/bin` otherwise.

It prints each step, checks the installed binary with `wraith --version`, and
warns if the install directory is not on your `PATH`.

## Installer options

Install into a custom directory:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_INSTALL_DIR="$HOME/bin" sh
```

Pin a specific version:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_VERSION=0.5.2 sh
```

Quiet mode for CI or scripts:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_QUIET=1 sh
```

Use an alternate release repository or asset mirror:

```sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_RELEASE_REPO=owner/repo sh
curl -fsSL https://wraith.cx/install.sh | WRAITH_RELEASE_BASE_URL=https://example.com/releases sh
```

Current prebuilt targets:

- `x86_64-unknown-linux-gnu`
- `aarch64-apple-darwin`

Linux ARM64 and Intel macOS installers will be enabled after release runners for
those targets are validated. Unsupported platforms fail before installation.

## Build from source

Wraith is a single Rust binary with no runtime dependencies. The full source
repository is private during the current beta. If you have source access, build
from the repository URL you were given:

```sh
git clone <source-repo-url> wraith
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

## Manual checksum verification

The install script verifies SHA-256 checksums automatically. To inspect a release
manually, download the archive and matching `.sha256` file from
[`bobisme/wraith-releases`](https://github.com/bobisme/wraith-releases), then run:

```sh
sha256sum -c wraith-<target>.tar.gz.sha256
```

On macOS:

```sh
shasum -a 256 -c wraith-<target>.tar.gz.sha256
```

## Uninstall

Remove the installed binary from the directory reported by the installer:

```sh
rm -f ~/.local/bin/wraith
# or, if installed system-wide:
sudo rm -f /usr/local/bin/wraith
```

## PATH troubleshooting

If `wraith --version` fails after installation, add the install directory to
your shell path and restart the shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For persistent shell configuration, add that line to `~/.zshrc`, `~/.bashrc`, or
your shell profile.

## Verify

```sh
wraith --version
```

## Runtime requirements

- **OS**: macOS ARM64 or Linux x86_64 for prebuilt binaries; macOS x86_64 and Linux ARM64 from source for now
- **Runtime dependencies**: none; wraith is a single static binary
- **Recording**: access to the upstream API you want to twin
- **LLM-assisted repair** (optional): local model via ollama, or cloud provider API key

## Prebuilt target matrix

| Target | Status |
|---|---|
| Linux x86_64 | Prebuilt |
| macOS Apple silicon | Prebuilt |
| Linux ARM64 | Build from source until release runners are validated |
| macOS Intel | Build from source until release runners are validated |

## Next steps

```sh
wraith init myapi --base-url https://api.example.com
```

See the [Quickstart](/quickstart/) to build your first twin in 5 minutes.
