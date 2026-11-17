"""Check exported real-device assets against the original NVIDIA fixture.

This checks structural integrity, not the semantic correctness of corrections.
Review the reported changes and web evidence separately before acceptance.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'shared/session-agent/fixtures/nvidia-transcript.md'
SEGMENT = re.compile(r'^## Segment ([^\n]+)\n(Order: \d+; startSample: \d+; endSample: \d+)\n', re.M)


def segments(text):
    matches = list(SEGMENT.finditer(text))
    return [(match.group(1), match.group(2), text[match.end():
            matches[index + 1].start() if index + 1 < len(matches) else len(text)].strip())
            for index, match in enumerate(matches)]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(directory, original=None):
    corrected_path = directory / 'transcript.corrected.md'
    report_path = directory / 'asr-review.md'
    notes_path = directory / 'structured-notes.md'
    before = segments(SOURCE.read_text())
    after = segments(corrected_path.read_text()) if corrected_path.exists() else []
    report = report_path.read_text() if report_path.exists() else ''
    checks = {
        'originalUnchanged': digest(original) == digest(SOURCE) if original else None,
        'allSegmentIdentitiesAndRangesPreserved': [(i, t) for i, t, _ in before] == [(i, t) for i, t, _ in after],
        'noEmptyTranscriptSegments': bool(after) and all(text for _, _, text in after),
        'reviewComplete': bool(re.search(r'^review_status:\s*[\"\x27]?complete[\"\x27]?\s*$', report, re.M)),
        'notesPresent': notes_path.exists() and notes_path.stat().st_size > 0,
    }
    by_id = {i: text for i, _, text in after}
    changed = [{'id': i, 'original': text, 'corrected': by_id[i]} for i, _, text in before
               if i in by_id and text != by_id[i]]
    return {
        'checks': checks, 'sourceSegments': len(before), 'correctedSegments': len(after),
        'changedSegments': changed,
        'reviewSourceLinks': sorted(set(re.findall(r'https?://[^\s<>\)\]]+', report))),
        'files': [{'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)}
                  for path in sorted(directory.glob('*.md'))],
        'semanticReviewStillRequired': True,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('assets', type=Path)
    parser.add_argument('--original', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = inspect(args.assets, args.original)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({**result['checks'], 'changedSegments': len(result['changedSegments']),
                      'sourceLinks': len(result['reviewSourceLinks'])}, ensure_ascii=False))
    raise SystemExit(0 if all(value is not False for value in result['checks'].values()) else 1)
