"""Reuse the bounded no-account probe collector for the official-runtime fixture."""
from pathlib import Path
import importlib.util

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('v8_probe_collector',HERE.parent/'v8_plain_probe/run_phone.py')
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.HERE=HERE
runner.BUNDLE='com.alma.litter.code-mode-probe'

if __name__=='__main__':raise SystemExit(runner.main())
