"""Run and collect only the disposable production-adapter test app."""
from pathlib import Path
import importlib.util

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("alma_probe_runner", HERE.parent / "ios_probe/run_phone.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.HERE = HERE
runner.BUNDLE = "com.alma.litter.backend-probe"

if __name__ == "__main__":
    runner.main()
