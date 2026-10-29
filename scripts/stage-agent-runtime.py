#!/usr/bin/env python3
"""Stage the Pi Agent runtime so build.rs embeds it into the desktop binary.

Two parts, both written into apps/desktop/bin/ (gitignored):

  pi-runtime.tar   Pi and its dependencies (node_modules/...), installed with
                   `npm ci` from apps/desktop/agent-runtime/package-lock.json.
                   JavaScript, wasm and per-platform prebuilds chosen at run
                   time, so one tar serves every platform.
  pi-node[.exe]    The official Node.js executable for one platform, checked
                   against the SHA-256 pinned in engine_manager.rs.

Usage:
  python3 scripts/stage-agent-runtime.py pi
  python3 scripts/stage-agent-runtime.py node                # this machine
  python3 scripts/stage-agent-runtime.py node darwin-x64     # a cross target

The versions come from apps/desktop/src/engine_manager.rs (PI_VERSION,
NODE_VERSION and expected_node_sha256), so there is one place to bump them.
"""

import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "apps" / "desktop"
RUNTIME_DIR = DESKTOP / "agent-runtime"
ENGINE_MANAGER = DESKTOP / "src" / "engine_manager.rs"
OUT_DIR = DESKTOP / "bin"
PI_PACKAGE = "@earendil-works/pi-coding-agent"
NODE_PLATFORMS = ("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-arm64", "win-x64")
INSTALL_SCRIPTS = ("preinstall", "install", "postinstall")
# Install scripts that are reviewed and harmless to skip, by package, hook and
# exact command. A changed command fails the check again, for another review.
#   protobufjs: only warns when a dependent pins it with the wrong range prefix.
#   @google/genai: a no-op echo.
SKIPPABLE_SCRIPTS = {
    ("protobufjs", "postinstall"): "node scripts/postinstall",
    ("@google/genai", "preinstall"): "echo 'preinstall: no-op'",
}


def fail(msg):
    sys.exit(f"stage-agent-runtime: {msg}")


def rust_const(name):
    m = re.search(rf'pub const {name}: &str = "([^"]+)";', ENGINE_MANAGER.read_text(encoding="utf-8"))
    if not m:
        fail(f"{name} not found in {ENGINE_MANAGER}")
    return m.group(1)


def node_digests():
    text = ENGINE_MANAGER.read_text(encoding="utf-8")
    return dict(re.findall(r'"(node-v[^"]+)"\s*=>\s*\{\s*"([0-9a-f]{64})"', text))


def host_node_platform():
    os_name = {"Darwin": "darwin", "Linux": "linux", "Windows": "win"}.get(platform.system())
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    if not os_name or not arch:
        fail(f"no Node.js build for {platform.system()} {platform.machine()}")
    return f"{os_name}-{arch}"


def stage_node(node_platform):
    if node_platform not in NODE_PLATFORMS:
        fail(f"unknown platform {node_platform!r}; one of {', '.join(NODE_PLATFORMS)}")
    version = rust_const("NODE_VERSION")
    windows = node_platform.startswith("win-")
    archive = f"node-v{version}-{node_platform}.{'zip' if windows else 'tar.gz'}"
    expected = node_digests().get(archive)
    if not expected:
        fail(f"no pinned SHA-256 for {archive} in expected_node_sha256")

    url = f"https://nodejs.org/dist/v{version}/{archive}"
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as resp:
        data = resp.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        fail(f"{archive}: SHA-256 {actual} does not match the pinned {expected}")

    root = f"node-v{version}-{node_platform}"
    if windows:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            node = zf.read(f"{root}/node.exe")
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            member = tf.extractfile(f"{root}/bin/node")
            if member is None:
                fail(f"{archive} has no {root}/bin/node")
            node = member.read()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / ("pi-node.exe" if windows else "pi-node")
    out.write_bytes(node)
    out.chmod(0o755)
    print(f"staged Node.js {version} ({node_platform}) -> {out} ({len(node) / 1e6:.1f} MB)")


def prune(node_modules):
    """Drop what Pi never loads at run time, to keep the embedded tar small.

    Pi's own package is left whole: it reads its docs and changelog itself.
    """
    pi_dir = node_modules / PI_PACKAGE
    removed = 0
    shutil.rmtree(node_modules / ".bin", ignore_errors=True)
    for path in sorted(node_modules.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        name = path.name
        if name.endswith(".map") or (
            pi_dir not in path.parents and re.search(r"\.d\.[cm]?ts$", name)
        ):
            removed += path.stat().st_size
            path.unlink()
    return removed


def check_tree(node_modules):
    problems = []
    for path in node_modules.rglob("*"):
        rel = path.relative_to(node_modules.parent)
        if path.is_symlink():
            problems.append(f"symlink {rel} (does not unpack portably)")
        elif path.suffix == ".node" and "prebuilds" not in path.relative_to(node_modules).parts:
            # Prebuilds ship one file per platform and the package picks one at
            # run time (pi-tui does); anything else was compiled for this host.
            problems.append(f"native module {rel} (would tie the tar to one platform)")
        elif path.name == "package.json" and path.is_file():
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
            if isinstance(scripts, dict):
                for hook in INSTALL_SCRIPTS:
                    if hook in scripts and SKIPPABLE_SCRIPTS.get((manifest.get("name"), hook)) != scripts[hook]:
                        problems.append(f"{rel} declares a {hook} script, skipped by --ignore-scripts")
    if problems:
        fail("the Pi runtime is not portable:\n  " + "\n  ".join(problems))


def smoke_test(work, pi_dir, manifest, version):
    """Run the pruned Pi once, so a pruning mistake fails here, not on users."""
    node = shutil.which("node")
    if not node:
        fail("node is not on PATH")
    bin_field = manifest.get("bin")
    entry = bin_field.get("pi") if isinstance(bin_field, dict) else bin_field
    if not entry:
        fail(f"{PI_PACKAGE} declares no `pi` bin")
    env = dict(os.environ, PI_OFFLINE="1", PI_TELEMETRY="0", PI_CODING_AGENT_DIR=str(work / "agent-home"))
    out = subprocess.run(
        [node, str(pi_dir / entry), "--version"],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if out.returncode != 0 or version not in out.stdout + out.stderr:
        fail(f"pruned Pi did not run (`pi --version` exit {out.returncode}):\n{out.stdout}{out.stderr}")
    print(f"smoke test: pi --version -> {(out.stdout or out.stderr).strip()}")


def stage_pi():
    version = rust_const("PI_VERSION")
    manifest = json.loads((RUNTIME_DIR / "package.json").read_text(encoding="utf-8"))
    pinned = manifest.get("dependencies", {}).get(PI_PACKAGE)
    if pinned != version:
        fail(f"agent-runtime/package.json pins {PI_PACKAGE}@{pinned}, but PI_VERSION is {version}")
    lock = RUNTIME_DIR / "package-lock.json"
    if not lock.exists():
        fail(
            f"{lock.relative_to(ROOT)} is missing. Create and commit it:\n"
            "  npm --prefix apps/desktop/agent-runtime install --package-lock-only --ignore-scripts"
        )
    locked = json.loads(lock.read_text(encoding="utf-8")).get("packages", {}).get(f"node_modules/{PI_PACKAGE}", {})
    if locked.get("version") != version:
        fail(f"package-lock.json locks {PI_PACKAGE}@{locked.get('version')}, but PI_VERSION is {version}; regenerate it")

    npm = shutil.which("npm")
    if not npm:
        fail("npm is not on PATH")
    with tempfile.TemporaryDirectory(prefix="duckle-pi-runtime-") as tmp:
        work = Path(tmp)
        shutil.copy2(RUNTIME_DIR / "package.json", work / "package.json")
        shutil.copy2(lock, work / "package-lock.json")
        subprocess.run(
            [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            cwd=work,
            check=True,
        )
        node_modules = work / "node_modules"
        installed = json.loads((node_modules / PI_PACKAGE / "package.json").read_text(encoding="utf-8"))
        if installed.get("version") != version:
            fail(f"npm ci installed {PI_PACKAGE}@{installed.get('version')}, expected {version}")
        saved = prune(node_modules)
        check_tree(node_modules)
        smoke_test(work, node_modules / PI_PACKAGE, installed, version)

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out = OUT_DIR / "pi-runtime.tar"
        files = 0
        with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tf:
            for path in sorted(node_modules.rglob("*")):
                arcname = path.relative_to(work).as_posix()
                info = tf.gettarinfo(str(path), arcname)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                if path.is_file():
                    files += 1
                    with open(path, "rb") as fh:
                        tf.addfile(info, fh)
                else:
                    tf.addfile(info)
    print(
        f"staged {PI_PACKAGE}@{version} -> {out} "
        f"({files} files, {out.stat().st_size / 1e6:.1f} MB, pruned {saved / 1e6:.1f} MB)"
    )


def main(argv):
    if len(argv) >= 1 and argv[0] == "pi" and len(argv) == 1:
        stage_pi()
    elif len(argv) >= 1 and argv[0] == "node" and len(argv) <= 2:
        stage_node(argv[1] if len(argv) == 2 else host_node_platform())
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    os.chdir(ROOT)
    main(sys.argv[1:])
