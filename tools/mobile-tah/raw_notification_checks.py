"""Host-only Raw observation checks using the real bundle and core_replay host.

Run: python3 tools/mobile-tah/raw_notification_checks.py
Optional: --bundle shared/tah-runtime/generated/alma-tah.js

Default builds with the unchanged production bundler in a temporary tree. All
bundle outputs, host executable, synthetic input and SQLite files stay there.
No production files, real credentials or model endpoints are touched.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CORE = REPO / "shared/tah-runtime"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_bundle(temp):
    build = temp / "tools/mobile-tah"
    core = temp / "shared/tah-runtime"
    build.mkdir(parents=True)
    core.mkdir(parents=True)
    # Copy the real build entry points verbatim; symlinks only supply read inputs.
    for name in ("build_bundle.mjs", "runtime_notifications.mjs"):
        shutil.copyfile(HERE / name, build / name)
    (build / "node_modules").symlink_to(HERE / "node_modules", target_is_directory=True)
    for name in ("platform", "upstream", "vendor", "source-lock.json"):
        (core / name).symlink_to(CORE / name, target_is_directory=(CORE / name).is_dir())
    subprocess.run(["node", str(build / "build_bundle.mjs")], check=True,
                   capture_output=True, text=True, timeout=60)
    return core / "generated/alma-tah.js"


def verify_bundle(bundle):
    manifest = json.loads(bundle.with_name("bundle-manifest.json").read_text())
    sha = digest(bundle)
    if manifest["sha256"] != sha:
        raise RuntimeError("Bundle does not match its manifest")
    changes = manifest.get("runtimeNotificationChanges", [])
    matches = [item for item in changes if item["module"] == "/upstream/src/app-runtime/actions.ts"]
    if len(matches) != 1:
        raise RuntimeError("Bundle lacks the production AppActions observation seam/provenance; rebuild it")
    source = CORE / "upstream/src/app-runtime/actions.ts"
    if matches[0]["sourceSHA256"] != digest(source):
        raise RuntimeError("Bundle AppActions provenance does not match the adopted source")
    return sha


def fixture_input():
    value = json.loads((HERE / "fixtures/core-replay.json").read_text())
    profile = json.loads((CORE / "upstream/providers/codex/app-profile.json").read_text())
    profile["profileIdentity"] = "1" * 64
    prompts = CORE / "upstream/prompts"
    value["config"] = {
        "profiles": [profile],
        "actionInstructions": (prompts / "action_instructions/structured_notes_v4_3.txt").read_text(),
        "resources": {key: (prompts / "system_prompts" / name).read_text() for key, name in {
            "actorPromptTemplate": "actor_prompt_v4_2.txt",
            "rawGuardianPrompt": "safety_guardian_raw_prompt_v0_3.txt",
            "extraGuardianPrompt": "safety_guardian_extra_prompt_v0_6.txt",
            "safetyPolicy": "safety_guardian_policy_v0_2.txt",
        }.items()},
    }
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, help="Test an existing bundle and adjacent manifest")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="raw_notification_checks-") as directory:
        # macOS tempfile commonly uses /var -> /private/var. Honor the real
        # journal's canonical-path check rather than weakening that boundary.
        temp = Path(directory).resolve()
        bundle = args.bundle.resolve() if args.bundle else build_bundle(temp)
        sha = verify_bundle(bundle)
        # Freeze the selected real artifact for this run (Main may be rebuilding).
        frozen_bundle = temp / "raw_notification_bundle.js"
        shutil.copyfile(bundle, frozen_bundle)
        if digest(frozen_bundle) != sha:
            raise RuntimeError("Bundle changed while being captured; rerun")
        script = temp / "raw_notification_fixture.js"
        script.write_text((HERE / "core_replay.js").read_text() + "\n" +
                          (HERE / "raw_notification_checks.js").read_text())
        input_path = temp / "raw_notification_input.json"
        input_path.write_text(json.dumps(fixture_input()))
        app = REPO / "apps/ios/Sources/AlmaTAH"
        sources = [app / "Runtime/AlmaTAHJavaScriptHost.swift",
                   app / "Runtime/TAHJavaScriptBytePrimitives.swift",
                   *sorted((app / "Persistence").glob("TAH*.swift")), HERE / "core_replay.swift"]
        binary = temp / "raw_notification_host"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-strict-concurrency=complete",
                        "-parse-as-library", *map(str, sources), "-lsqlite3", "-o", str(binary)],
                       check=True, timeout=120)
        output = subprocess.check_output([str(binary), str(frozen_bundle), str(script), str(input_path),
                                          str(temp / "journal")], text=True, timeout=45)
        report = json.loads(output)
        if not report["passed"] or report["modelCalls"] or report["realCredentials"]:
            raise RuntimeError("Raw notification checks failed their execution boundary")
        if len(report["cases"]) != 12:
            raise RuntimeError("Incomplete Raw notification case matrix")
        report["bundleSHA256"] = sha
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
