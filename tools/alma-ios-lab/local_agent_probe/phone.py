#!/usr/bin/env python3
"""Explicit, bounded qualification through the tested pymobiledevice3 route.

Only this bundle is launched; only two allowlisted status documents are pulled.
No login, prompt override, credential access, device discovery, or launch retry.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
BUNDLE = "com.alma.litter.agent-probe"
TOOL = HERE.parent / ".cache/device-tools/bin/pymobiledevice3"
PREPARATION = "Documents/preparation-status.json"
VERIFICATION = "Documents/verification-status.json"
INSTALL_TIMEOUT, LAUNCH_TIMEOUT, PULL_TIMEOUT, RUN_TIMEOUT = 180, 45, 20, 180
PHASES = {
    PREPARATION: {"booting", "kernel-ready", "connecting", "ready", "failed"},
    VERIFICATION: {"not-ready", "restoring-account", "checking-models", "creating-session", "requesting-model", "completed", "failed"},
}


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Failure(Exception):
    def __init__(self, kind):
        self.kind = kind
        super().__init__(kind)


def failure_kind(output):
    text = output.lower()
    if any(s in text for s in ("devicelocked", "device is locked", "device locked", "passwordprotected", "password protected")):
        return "device_locked"
    if any(s in text for s in ("connectionterminated", "connectionreset", "connection reset", "brokenpipe", "broken pipe", "connectionaborted", "connection aborted", "rsd disconnected", "rsd connection closed", "incompletereaderror")):
        return "rsd_disconnected"
    if any(s in text for s in ("nodeviceconnected", "no device connected", "devicenotfound")):
        return "device_unavailable"
    if any(s in text for s in ("object_not_found", "objectnotfound", "filenotfound", "no such file or directory")):
        return "status_missing"
    return "command_failed"


def launch_pid(stdout):
    # CLI print_json returns the actual core-device response, without --console.
    try:
        value = json.loads(re.sub(r"\x1b\[[0-9;]*m", "", stdout).strip())
    except (ValueError, TypeError):
        raise Failure("launch_identity_unconfirmed") from None
    found = set()

    def visit(item):
        if isinstance(item, dict):
            for key, val in item.items():
                if key in ("processIdentifier", "pid") and type(val) is int and val > 0:
                    found.add(val)
                else:
                    visit(val)
        elif isinstance(item, list):
            for val in item:
                visit(val)

    visit(value)
    if len(found) != 1:
        raise Failure("launch_identity_unconfirmed")
    return found.pop()


def safe_status(raw, remote):
    """Keep phase/PID/counts only; discard detail, model text, and unknown fields."""
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Failure("invalid_status_json") from None
    if not isinstance(value, dict) or not isinstance(value.get("phase"), str) or value["phase"] not in PHASES[remote]:
        raise Failure("unknown_status_phase")
    if type(value.get("pid")) is not int or value["pid"] <= 0:
        raise Failure("invalid_status_pid")
    result = {"phase": value["phase"], "pid": value["pid"]}
    for key in ("accountReady", "terminalIdle", "replyMatches", "allChecksPassed", "artifactMatches", "webArtifactMatches"):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    for key in ("modelCount", "assistantMessages", "replyCharacters", "commandCount", "fileChangeCount", "webSearchCount"):
        if type(value.get(key)) is int and value[key] >= 0:
            result[key] = value[key]
    for key in ("elapsedSeconds", "seconds"):
        val = value.get(key)
        if type(val) in (int, float) and 0 <= val <= 86400 and math.isfinite(val):
            result[key] = val
    model = value.get("model")
    if isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", model):
        result["model"] = model
    return result


def verified_result(status, tools_web=False):
    if status.get("terminalIdle") is not True or status.get("accountReady") is not True:
        return False
    if status.get("modelCount", 0) < 1 or status.get("assistantMessages", 0) < 1:
        return False
    if tools_web:
        return all(status.get(key) is True for key in ("allChecksPassed", "artifactMatches", "webArtifactMatches")) and all(
            status.get(key, 0) > 0 for key in ("commandCount", "fileChangeCount", "webSearchCount")
        )
    return status.get("replyMatches") is True


class Runner:
    def __init__(self, udid, output, verify=False, *, tools_web=False, run=subprocess.run, clock=time.monotonic, sleep=time.sleep):
        self.udid, self.output, self.verify = udid, output, verify
        self.tools_web = tools_web
        if tools_web and not verify:
            raise ValueError("tools/Web mode requires explicit verification")
        self.run, self.clock, self.sleep = run, clock, sleep
        self.started = clock()
        self.deadline = None
        self.pid = None
        self.baseline = {}
        self.seen = set()
        self.env = os.environ.copy()
        # Inherited native/tunnel settings must not override this tested route.
        for name in ("PYMOBILEDEVICE3_NATIVE", "PYMOBILEDEVICE3_TUNNEL", "PYMOBILEDEVICE3_RSD", "PYMOBILEDEVICE3_USERSPACE", "FORCE_COLOR", "CLICOLOR_FORCE"):
            self.env.pop(name, None)
        self.env.update(PYMOBILEDEVICE3_UDID=udid, NO_COLOR="1", TERM="dumb")
        self.report = {
            "bundle": BUNDLE, "udid": udid, "started_at": utc(),
            "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "mode": "verify-tools-web" if tools_web else ("verify-subscription" if verify else "prepare-only"),
            "verification_may_have_started": False, "outcome": "running",
            "timeouts_seconds": {"install": 180, "launch": 45, "pull": 20, "qualification": 180},
            "history": [], "commands": [],
        }
        output.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.save()

    def save(self):
        temporary = self.output / "run.json.tmp"
        temporary.write_text(json.dumps(self.report, indent=2, allow_nan=False) + "\n")
        temporary.replace(self.output / "run.json")

    def event(self, event, **data):
        self.report["history"].append({"host_at": utc(), "host_elapsed_seconds": round(self.clock() - self.started, 3), "event": event, **data})
        self.save()

    def command(self, phase, args, timeout):
        if self.deadline is not None:
            timeout = min(timeout, self.deadline - self.clock())
        if timeout <= 0:
            raise Failure("qualification_timeout")
        command = [str(TOOL), *args]
        receipt = {"phase": phase, "command": command, "started_at": utc(), "timeout_seconds": round(timeout, 3)}
        self.report["commands"].append(receipt)
        self.save()
        try:
            result = self.run(command, env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
            receipt["returncode"] = result.returncode
            # Raw command output may contain arbitrary tool errors; never persist it.
            if result.returncode:
                kind = failure_kind((result.stdout or "") + (result.stderr or ""))
                receipt["failure"] = kind
                if phase == "pull" and kind == "status_missing":
                    return None
                raise Failure(kind)
            return result
        except subprocess.TimeoutExpired:
            receipt["failure"] = "command_timeout"
            raise Failure("command_timeout") from None
        except OSError:
            receipt["failure"] = "tool_unavailable"
            raise Failure("tool_unavailable") from None
        finally:
            receipt["finished_at"] = utc()
            self.save()

    def pull(self, remote):
        if remote not in PHASES:
            raise Failure("invalid_status_path")
        # Raw status files are ephemeral: receipts retain only the allowlist.
        with tempfile.TemporaryDirectory(prefix="status-", dir=self.output) as temp:
            destination = Path(temp) / Path(remote).name
            result = self.command("pull", ["apps", "pull", "--udid", self.udid, BUNDLE, remote, str(destination)], PULL_TIMEOUT)
            if result is None or not destination.is_file():
                return None
            with destination.open("rb") as source:
                raw = source.read(65537)
            if len(raw) > 65536:
                raise Failure("oversized_status")
            return safe_status(raw, remote), hashlib.sha256(raw).hexdigest()

    def execute(self, app=None):
        try:
            if app is not None:
                self.command("install", ["apps", "install", "--udid", self.udid, "--developer", "--streaming", str(app)], INSTALL_TIMEOUT)
                self.event("installed")
            # Installation is separately bounded; the 180-second qualification
            # budget includes stale-report baseline pulls, launch, and all polling.
            self.deadline = self.clock() + RUN_TIMEOUT
            paths = [PREPARATION, VERIFICATION] if self.verify else [PREPARATION]
            for remote in paths:
                existing = self.pull(remote)
                if existing:
                    self.baseline[remote] = existing[1]
            arguments = ["--prepare-only"] + (["--verify-tools-web" if self.tools_web else "--verify-subscription"] if self.verify else [])
            self.report["verification_may_have_started"] = self.verify
            self.event("launch_attempted")
            result = self.command("launch", ["developer", "core-device", "launch-application", "--userspace", "--kill-existing", BUNDLE, "--", *arguments], LAUNCH_TIMEOUT)
            try:
                self.pid = launch_pid(result.stdout)
            except Failure:
                kind = failure_kind((result.stdout or "") + (result.stderr or ""))
                raise Failure(kind if kind in {"device_locked", "rsd_disconnected", "device_unavailable"} else "launch_identity_unconfirmed") from None
            self.report["pid"] = self.pid
            self.event("launched", pid=self.pid)
            latest = {}
            while self.clock() < self.deadline:
                for remote in paths:
                    pulled = self.pull(remote)
                    if pulled is None:
                        self.event("status_pending", path=remote)
                        continue
                    status, digest = pulled
                    if status["pid"] != self.pid or digest == self.baseline.get(remote):
                        if remote in self.seen and status["pid"] != self.pid:
                            raise Failure("process_changed")
                        self.event("stale_status_ignored", path=remote, reported_pid=status["pid"])
                        continue
                    self.seen.add(remote)
                    latest[remote] = status
                    local = self.output / Path(remote).name
                    temporary = local.with_suffix(".json.tmp")
                    temporary.write_text(json.dumps(status, indent=2, allow_nan=False) + "\n")
                    temporary.replace(local)
                    self.event("status", path=remote, **status)
                    if status["phase"] in {"failed", "not-ready"}:
                        raise Failure("application_failed")
                prepared = latest.get(PREPARATION, {}).get("phase") == "ready"
                verified = latest.get(VERIFICATION, {})
                if self.verify and verified.get("phase") == "completed":
                    if not verified_result(verified, self.tools_web):
                        raise Failure("verification_failed")
                    if prepared:
                        break
                elif not self.verify and prepared:
                    break
                remaining = self.deadline - self.clock()
                if remaining > 0:
                    self.sleep(min(1.0, remaining))
            else:
                raise Failure("qualification_timeout")
            self.report["outcome"] = "tools_web_verified" if self.tools_web else ("subscription_verified" if self.verify else "prepared")
            return 0
        except KeyboardInterrupt:
            self.report["outcome"] = "interrupted"
            self.event("stopped", reason="interrupted", no_relaunch=True)
            return 130
        except Failure as error:
            self.report["outcome"] = error.kind
            self.event("stopped", reason=error.kind, no_relaunch=True)
            return 1
        finally:
            self.report["finished_at"] = utc()
            self.report["elapsed_seconds"] = round(self.clock() - self.started, 3)
            self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare-only", action="store_true", help="default: bootstrap only, no subscription/model request")
    mode.add_argument("--verify-subscription", action="store_true", help="explicitly run the app's existing fixed synthetic subscription check once; never log in")
    mode.add_argument("--verify-tools-web", action="store_true", help="explicitly run the fixed Bash/Python/Node/native patch/official Web qualification")
    parser.add_argument("--udid", default=os.environ.get("PYMOBILEDEVICE3_UDID"))
    parser.add_argument("--install", metavar="APP", type=Path, help="opt-in streaming install of this bundle's actual built .app")
    parser.add_argument("--output", type=Path, help="new receipt directory; must not already exist")
    args = parser.parse_args()
    if not args.udid or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{3,127}", args.udid):
        parser.error("set PYMOBILEDEVICE3_UDID or supply --udid; automatic device selection is disabled")
    if not TOOL.is_file():
        parser.error("the cached device-tools pymobiledevice3 executable is required")
    app = args.install.resolve() if args.install else None
    if app is not None:
        try:
            if not app.is_dir() or app.suffix != ".app": raise ValueError()
            with (app / "Info.plist").open("rb") as source:
                if plistlib.load(source).get("CFBundleIdentifier") != BUNDLE: raise ValueError()
        except (OSError, ValueError, plistlib.InvalidFileException):
            parser.error("--install must name the actual built .app for com.alma.litter.agent-probe")
    output = args.output.resolve() if args.output else HERE / ".build/phone-runs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    if output.exists(): parser.error("receipt directory must be new")
    runner = Runner(args.udid, output, args.verify_subscription or args.verify_tools_web, tools_web=args.verify_tools_web)
    code = runner.execute(app)
    print(json.dumps({"outcome": runner.report["outcome"], "pid": runner.pid, "report": str(output / "run.json"), "verification_may_have_started": runner.report["verification_may_have_started"]}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
