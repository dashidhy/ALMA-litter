"""Bounded host runner for the pinned iSH ARM64 guest, not native host tools."""
from pathlib import Path
import argparse, hashlib, json, os, re, resource, shlex, signal, subprocess, time

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def run_case(identifier, script, rootfs, output_dir, timeout=30, mounts=None):
    output_dir.mkdir(parents=True, exist_ok=True)
    record_path = output_dir / (identifier + ".json")
    if record_path.exists():
        raise FileExistsError(record_path)
    stdout_path, stderr_path = [output_dir / (identifier + s) for s in [".stdout", ".stderr"]]
    binary = CACHE / "ish-host-build/ish"
    env = dict(os.environ)
    if mounts:
        env["ISH_BIND_MOUNTS"] = ",".join(mounts)
    else:
        env.pop("ISH_BIND_MOUNTS", None)
    # Limit only the new probe process. The parent/other applications are untouched.
    def limits():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Also applies to guest payload files, so permit the ~48 MiB Node
        # executable. Capture logs have a separate, much smaller guard below.
        resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (int(timeout) + 5, int(timeout) + 6))
    began = time.monotonic()
    peak = 0
    stopped = None
    with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
        # The host CLI adds /data for -f; IshInstance::boot has a different API.
        # The standalone iSH CLI can return host code 0 when guest PID 1 exits
        # nonzero. Run the case as a guest child and preserve its wait status.
        wrapped = "/bin/sh -c " + shlex.quote(script) + '; rc=$?; printf "\\n__ALMA_GUEST_EXIT__:%d\\n" "$rc"; exit "$rc"'
        proc = subprocess.Popen([str(binary), "-f", str(rootfs), "/bin/sh", "-c", wrapped],
            stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=env,
            start_new_session=True, preexec_fn=limits)
        while proc.poll() is None:
            usage = subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)],
                                   capture_output=True, text=True, timeout=2)
            if usage.stdout.strip().isdigit():
                peak = max(peak, int(usage.stdout.strip()) * 1024)
            if time.monotonic() - began > timeout:
                stopped = "wall_timeout"
            if peak > 1536 * 1024 * 1024:
                stopped = "rss_guard"
            if stdout_path.stat().st_size > 4 * 1024 * 1024 or stderr_path.stat().st_size > 4 * 1024 * 1024:
                stopped = "output_guard"
            if stopped:
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                break
            time.sleep(0.15)
        code = proc.wait(timeout=5)
    stdout, stderr = stdout_path.read_text(errors="replace"), stderr_path.read_text(errors="replace")
    codes = re.findall(r"^__ALMA_GUEST_EXIT__:(\d+)$", stdout, re.M)
    guest_code = int(codes[-1]) if codes else None
    effective_code = guest_code if code == 0 and stopped is None else code
    result = dict(id=identifier, command=script, guestArchitecture="aarch64", host="macOS ARM64",
        rootfs=str(rootfs), returncode=effective_code, hostReturncode=code, guestReturncode=guest_code,
        seconds=time.monotonic()-began,
        stopReason=stopped, peakSampledRSSBytes=peak, stdout=stdout, stderr=stderr,
        binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest(),
        scope="iSH host CLI; not Litter Rust exec hook, not physical iPhone, no model calls")
    record_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ["id", "returncode", "seconds", "stopReason", "peakSampledRSSBytes"]}), flush=True)
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--id", required=True)
    p.add_argument("--script", required=True)
    p.add_argument("--rootfs", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--timeout", type=int, default=30)
    p.add_argument("--mount", action="append", default=[])
    a = p.parse_args()
    run_case(a.id, a.script, a.rootfs.resolve(), a.output_dir.resolve(), a.timeout, a.mount)
