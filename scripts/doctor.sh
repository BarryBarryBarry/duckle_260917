#!/usr/bin/env bash
# Duckle local development environment check.
#
#   bash scripts/doctor.sh
#
# Verifies every tool needed to run `cargo tauri dev`, plus the two
# project-state prerequisites that are easy to miss:
#   - frontend/node_modules (the Vite dev server's dependencies)
#   - a built duckle-runner (apps/desktop/build.rs embeds it and panics
#     at build time when it is absent)
#
# Exits 0 when everything required is satisfied, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Version floors, kept in sync with the manifests they come from.
RUST_MIN="1.80"          # Cargo.toml  -> workspace.package.rust-version
TAURI_CLI_MAJOR="2"      # README      -> cargo install tauri-cli --version "^2"
# frontend/package.json -> engines.node = "^20.19.0 || >=22.12.0"
NODE_MIN_LTS20="20.19.0"
NODE_MIN_LTS22="22.12.0"

if [ -t 1 ]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BOLD=''; DIM=''; RESET=''
fi

FAILED=0
WARNED=0

pass() { printf '  %s✔%s %-22s %s\n' "$GREEN" "$RESET" "$1" "$2"; }
fail() { printf '  %s✘%s %-22s %s\n' "$RED" "$RESET" "$1" "$2"; FAILED=$((FAILED + 1)); }
warn() { printf '  %s!%s %-22s %s\n' "$YELLOW" "$RESET" "$1" "$2"; WARNED=$((WARNED + 1)); }
head2() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
hint() { printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }

# ver_ge A B -> prints 1 when A >= B, else 0. Compares dot-separated
# numeric components, ignoring any non-numeric suffix.
ver_ge() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        na = split(a, A, "."); nb = split(b, B, ".");
        n = (na > nb) ? na : nb;
        for (i = 1; i <= n; i++) {
            x = (i <= na) ? A[i] + 0 : 0;
            y = (i <= nb) ? B[i] + 0 : 0;
            if (x > y) { print 1; exit }
            if (x < y) { print 0; exit }
        }
        print 1
    }'
}

# First numeric version token in the argument, e.g. "1.98.1".
ver_of() { printf '%s' "$1" | grep -oE '[0-9]+(\.[0-9]+)+' | head -1; }

printf '%sDuckle environment check%s  %s%s%s\n' "$BOLD" "$RESET" "$DIM" "$REPO_ROOT" "$RESET"

# ---------------------------------------------------------------- required

head2 "Required"

# Rust toolchain
if command -v rustc >/dev/null 2>&1; then
    v="$(ver_of "$(rustc --version 2>/dev/null)")"
    if [ "$(ver_ge "$v" "$RUST_MIN")" = "1" ]; then
        pass "rustc" "$v"
    else
        fail "rustc" "$v (need >= $RUST_MIN)"
        hint "rustup update stable"
    fi
else
    fail "rustc" "not found"
    hint "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

if command -v cargo >/dev/null 2>&1; then
    pass "cargo" "$(ver_of "$(cargo --version 2>/dev/null)")"
else
    fail "cargo" "not found"
    hint "Comes with rustup; then: . \"\$HOME/.cargo/env\""
fi

# Tauri CLI
if cargo tauri --version >/dev/null 2>&1; then
    v="$(ver_of "$(cargo tauri --version 2>/dev/null)")"
    if [ "$(ver_ge "$v" "$TAURI_CLI_MAJOR")" = "1" ] &&
        [ "$(ver_ge "$((TAURI_CLI_MAJOR + 1))" "$v")" = "1" ]; then
        pass "cargo-tauri" "$v"
    else
        fail "cargo-tauri" "$v (need ${TAURI_CLI_MAJOR}.x)"
        hint "cargo install tauri-cli --version \"^${TAURI_CLI_MAJOR}\" --locked"
    fi
else
    fail "cargo-tauri" "not found"
    hint "cargo install tauri-cli --version \"^${TAURI_CLI_MAJOR}\" --locked"
fi

# Node. engines is "^20.19.0 || >=22.12.0": 20.19+ (but not 21.x) or 22.12+.
if command -v node >/dev/null 2>&1; then
    v="$(ver_of "$(node --version 2>/dev/null)")"
    ok=0
    if [ "$(ver_ge "$v" "$NODE_MIN_LTS20")" = "1" ] && [ "$(ver_ge "21.0.0" "$v")" = "1" ]; then
        ok=1
    fi
    if [ "$(ver_ge "$v" "$NODE_MIN_LTS22")" = "1" ]; then
        ok=1
    fi
    if [ "$ok" = "1" ]; then
        pass "node" "$v  $DIM($(command -v node))$RESET"
    else
        fail "node" "$v (need ^$NODE_MIN_LTS20 or >=$NODE_MIN_LTS22)"
        hint "Active binary: $(command -v node)"
        if command -v nvm >/dev/null 2>&1 || [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
            hint "nvm detected: nvm install 22 && nvm alias default 22"
        else
            hint "brew install node@22"
        fi
    fi
else
    fail "node" "not found"
fi

if command -v npm >/dev/null 2>&1; then
    pass "npm" "$(ver_of "$(npm --version 2>/dev/null)")"
else
    fail "npm" "not found"
fi

if command -v git >/dev/null 2>&1; then
    pass "git" "$(ver_of "$(git --version 2>/dev/null)")"
else
    fail "git" "not found"
fi

# Platform webview / build toolchain.
case "$(uname -s)" in
Darwin)
    if xcode-select -p >/dev/null 2>&1; then
        pass "Xcode CLT" "$(xcode-select -p)"
    else
        fail "Xcode CLT" "not installed"
        hint "xcode-select --install"
    fi
    ;;
Linux)
    if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
        pass "webkit2gtk-4.1" "$(pkg-config --modversion webkit2gtk-4.1)"
    else
        fail "webkit2gtk-4.1" "not found"
        hint "See https://tauri.app/start/prerequisites/"
    fi
    ;;
esac

# ---------------------------------------------------------------- optional

head2 "Optional"

if command -v sccache >/dev/null 2>&1; then
    if [ "${RUSTC_WRAPPER:-}" = "sccache" ] || [ "${RUSTC_WRAPPER:-}" = "$(command -v sccache)" ]; then
        pass "sccache" "$(ver_of "$(sccache --version 2>/dev/null)")  ${DIM}active via RUSTC_WRAPPER${RESET}"
    else
        warn "sccache" "installed but RUSTC_WRAPPER is not set"
        hint "export RUSTC_WRAPPER=sccache   # caches Rust builds across dirs"
    fi
else
    warn "sccache" "not installed (rebuilds will be slower)"
fi

if command -v duckdb >/dev/null 2>&1; then
    pass "duckdb CLI" "$(ver_of "$(duckdb --version 2>/dev/null)")"
else
    warn "duckdb CLI" "not installed (the app downloads it on first launch)"
fi

if command -v docker >/dev/null 2>&1; then
    pass "docker" "$(ver_of "$(docker --version 2>/dev/null)")"
else
    warn "docker" "not installed (only needed for the self-hosted web edition)"
fi

# ----------------------------------------------------------- project state

head2 "Project state"

if [ -d "$REPO_ROOT/frontend/node_modules" ]; then
    pass "frontend deps" "installed"
else
    fail "frontend deps" "frontend/node_modules missing"
    hint "npm --prefix frontend ci"
fi

# apps/desktop/build.rs embeds duckle-runner and panics when it cannot find
# one. It looks at apps/desktop/bin/ first, then target/<profile>/.
runner_found=""
for candidate in \
    "$REPO_ROOT/apps/desktop/bin/duckle-runner" \
    "$REPO_ROOT/target/debug/duckle-runner" \
    "$REPO_ROOT/target/release/duckle-runner"; do
    if [ -f "$candidate" ]; then
        runner_found="$candidate"
        break
    fi
done
if [ -n "$runner_found" ]; then
    pass "duckle-runner" "$(du -h "$runner_found" | cut -f1)  ${DIM}${runner_found#"$REPO_ROOT"/}${RESET}"
else
    fail "duckle-runner" "not built (apps/desktop/build.rs will panic)"
    hint "cargo build -p duckle-runner"
fi

# ---------------------------------------------------------------- summary

head2 "Summary"
if [ "$FAILED" -eq 0 ]; then
    printf '  %sReady.%s %d optional item(s) noted.\n\n' "$GREEN" "$RESET" "$WARNED"
    printf '  Start the desktop app:\n'
    printf '    %scd %s && cargo tauri dev%s\n\n' "$BOLD" "$REPO_ROOT" "$RESET"
    exit 0
else
    printf '  %s%d required check(s) failed.%s Fix the items marked ✘ above, then re-run.\n\n' \
        "$RED" "$FAILED" "$RESET"
    exit 1
fi
