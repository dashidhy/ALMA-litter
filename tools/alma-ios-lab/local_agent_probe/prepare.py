#!/usr/bin/env python3
"""Prepare only this probe's project; never build Rust, generate bindings, or run auth."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PRODUCTION = ROOT / "apps/ios/Sources/Litter/Models"
RUST = ROOT / "shared/rust-bridge/codex-mobile-client/src"
BUILD = HERE / ".build"


def logging_findings(source):
    """Conservative static gate for known body/credential-bearing logger arguments.

    This is a readiness check, not a general privacy verifier. Actual sources
    remain byte-for-byte unchanged and are referenced by the generated project.
    """
    findings = []
    for match in re.finditer(r"\bLLog\.\w+\(", source):
        index, depth, quoted, escaped = match.end(), 1, False, False
        while index < len(source) and depth:
            char = source[index]
            if quoted:
                if escaped: escaped = False
                elif char == "\\": escaped = True
                elif char == '"': quoted = False
            elif char == '"': quoted = True
            elif char == "(": depth += 1
            elif char == ")": depth -= 1
            index += 1
        call = source[match.start():index]
        keys = set(re.findall(r'"([A-Za-z_][A-Za-z_0-9]*)"\s*:', call))
        risky = keys & {"requestLine", "pathWithQuery", "body", "responseText", "payload", "token", "accessToken", "idToken", "refreshToken", "error"}
        if risky or "payloadJson:" in call or "callbackURL.absoluteString" in call:
            findings.append({"line": source.count("\n", 0, match.start()) + 1,
                             "reason": "dynamic OAuth data/error in log arguments", "keys": sorted(risky)})
    return findings


def first_existing(paths):
    return next((path for path in paths if path.is_file()), None)


def prepare(args):
    BUILD.mkdir(exist_ok=True)
    mode_dir = BUILD / args.mode
    mode_dir.mkdir(exist_ok=True)
    production_files = [PRODUCTION / name for name in ["ChatGPTOAuth.swift", "ChatGPTAuthRefreshProvider.swift", "LLog.swift"]]
    for path in production_files:
        if not path.is_file(): raise SystemExit(f"Required production source missing: {path}")
    contract = json.loads((HERE / "api_contract.json").read_text())
    for export in contract["exports"]:
        if not re.search(r"pub\s+(?:async\s+)?fn\s+" + export["name"] + r"\s*\(", (RUST / export["rust"]).read_text()):
            raise SystemExit(f"Actual Rust export changed: {export['name']}")
    findings = logging_findings(production_files[0].read_text())
    bindings = args.bindings or first_existing([
        ROOT / "apps/ios/Sources/Litter/Bridge/UniFFICodexClient.generated.swift",
        ROOT / "shared/rust-bridge/generated/swift/codex_mobile_client.swift",
    ])
    headers = args.headers or ROOT / "apps/ios/GeneratedRust/Headers"
    library = args.library or ROOT / "apps/ios/GeneratedRust/ios-device/libcodex_mobile_client.a"
    rootfs = args.rootfs
    bound = args.mode == "bound"
    if bound:
        if bindings is None or not bindings.is_file():
            raise SystemExit("Bound mode requires main's actual production generated Swift; no substitute is generated.")
        generated = bindings.read_text()
        for export in contract["exports"]:
            if not re.search(r"\bfunc\s+" + export["swift"] + r"\s*\(", generated):
                raise SystemExit(f"Generated method missing: {export['swift']}")
        for name in contract["types"]:
            if not re.search(r"\b(?:class|struct|enum|protocol|typealias)\s+" + name + r"\b", generated):
                raise SystemExit(f"Generated type missing: {name}")
        for name in ["codex_mobile_clientFFI.h", "module.modulemap"]:
            if not (headers / name).is_file(): raise SystemExit(f"Required generated FFI input missing: {name}")
        if args.require_link_inputs and not library.is_file():
            raise SystemExit("Main's matching iOS static library is required; this script will not build it.")
    if args.enable_bootstrap:
        if not bound or rootfs is None or not rootfs.is_dir() or rootfs.name != "fs":
            raise SystemExit("Enabling the real bootstrap requires bound mode and main's policy-ready rootfs directory named fs.")
    readiness = mode_dir / "ProbeBuildReadiness.swift"
    profile_inputs = {"schema": "alma.phone.qualification-build/v1", "nativeCodeModeProbe": args.native_code_mode_probe,
        "swift": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in sorted((HERE / "Sources").glob("*.swift")) + production_files}}
    if bound and library.is_file():
        with library.open("rb") as source:
            profile_inputs["librarySHA256"] = hashlib.file_digest(source, "sha256").hexdigest()
    if rootfs is not None: profile_inputs["rootfsRecipe"] = rootfs.parent.name
    profile_digest = hashlib.sha256(json.dumps(profile_inputs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (mode_dir / "qualification-profile.json").write_text(json.dumps({"digest": profile_digest, "inputs": profile_inputs}, indent=2) + "\n")
    readiness.write_text("// Generated probe configuration, not a generated API substitute.\n"
        + "enum ProbeBuildReadiness {\n"
        + f"    static let hasBindings = {str(bound).lower()}\n"
        + f"    static let oauthLoggingReady = {str(not findings).lower()}\n"
        + f"    static let runtimeBootstrapEnabled = {str(args.enable_bootstrap).lower()}\n"
        + f"    static let profileDigest = {json.dumps(profile_digest)}\n"
        + "}\n")
    spec = json.loads((HERE / "project.yml").read_text())
    target = spec["targets"]["AlmaLocalAgentProbe"]
    if args.native_code_mode_probe:
        if not bound:
            raise SystemExit("Native Code Mode qualification requires the actual bound library.")
        target["entitlements"] = {
            "path": str(mode_dir / "AlmaLocalAgentProbe.entitlements"),
            "properties": {"com.apple.developer.kernel.extended-virtual-addressing": True},
        }
    source_files = sorted((HERE / "Sources").glob("*.swift")) + [production_files[0], production_files[2], readiness]
    target["sources"] = [{"path": str(path)} for path in source_files]
    target["info"]["path"] = str(mode_dir / "Info.plist")
    if bound:
        source_files += [production_files[1], bindings]
        target["sources"] += [{"path": str(production_files[1])}, {"path": str(bindings)}]
        settings = target["settings"]["base"]
        settings["SUPPORTED_PLATFORMS"] = "iphoneos"
        settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "$(inherited) PROBE_HAS_BINDINGS"
        settings["HEADER_SEARCH_PATHS"] = ["$(inherited)", str(headers)]
        settings["SWIFT_INCLUDE_PATHS"] = ["$(inherited)", str(headers)]
        settings["OTHER_LDFLAGS"] = ["$(inherited)", str(library), "-lc++", "-lz", "-lresolv", "-lsqlite3"]
    if rootfs is not None:
        if not rootfs.is_dir() or rootfs.name != "fs": raise SystemExit("Rootfs must be an existing directory named fs.")
        target["sources"].append({"path": str(rootfs), "type": "folder", "buildPhase": "resources"})
    generated_spec = mode_dir / "project.yml"
    generated_spec.write_text(json.dumps(spec, indent=2) + "\n")
    evidence = {
        "mode": args.mode, "bundle": "com.alma.litter.agent-probe", "team": "C6635V7W82",
        "generated_api_substitutes": False, "live_actions_at_launch": False,
        "bindings": str(bindings) if bindings else None, "headers": str(headers), "library": str(library),
        "runtime_bootstrap_enabled": args.enable_bootstrap,
        "native_code_mode_probe": args.native_code_mode_probe,
        "qualification_profile_digest": profile_digest,
        "oauth_logging_ready": not findings, "oauth_logging_findings": findings,
        "production_source_hashes": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in production_files},
        "compile_sources": [str(path) for path in source_files],
        "sdk_frameworks": [dependency["sdk"] for dependency in target["dependencies"]],
        "swift_modules": ["SwiftUI", "Observation", "Foundation", "AuthenticationServices", "CryptoKit", "Network", "Security", "UIKit", "OSLog"],
        "provider_included": bound, "project_spec": str(generated_spec),
        "required_workspace": contract["qualification_workspace"],
    }
    (mode_dir / "compile-manifest.json").write_text(json.dumps(evidence, indent=2) + "\n")
    subprocess.run(["xcodegen", "generate", "--spec", str(generated_spec), "--project", str(mode_dir)], check=True)
    print(f"Prepared {args.mode} project. OAuth logging ready: {not findings}. Bootstrap enabled: {args.enable_bootstrap}.")
    return evidence


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["shell", "bound"], default="shell")
    for name in ["bindings", "headers", "library", "rootfs"]:
        parser.add_argument("--" + name, type=lambda value: Path(value).resolve())
    parser.add_argument("--enable-bootstrap", action="store_true", help="main only, after the ALMA-local policy vendor/archive/rootfs are ready")
    parser.add_argument("--native-code-mode-probe", action="store_true", help="opt-in qualification only; matching alma-code-mode-probe Rust build, extended VA, plain V8 without desktop memory sandbox")
    parser.add_argument("--require-link-inputs", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    prepare(arguments())
