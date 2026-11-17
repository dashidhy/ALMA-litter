"""Inspect actual Skill outputs; never generate or repair model work products."""
from pathlib import Path
import argparse
import difflib
import hashlib
import json
import re

SEGMENT = re.compile(r'^#{1,6}\s+(?:Segment|片段)\s+([A-Fa-f0-9-]+)\s*\nOrder:\s*(\d+);\s*startSample:\s*(\d+);\s*endSample:\s*(\d+)\s*\n', re.M)

def segments(text):
    matches = list(SEGMENT.finditer(text))
    return [(m.groups(), text[m.end(): matches[i+1].start() if i+1 < len(matches) else len(text)].strip())
            for i,m in enumerate(matches)]

def inspect(source, assets):
    original = source.read_text()
    expected = segments(original)
    corrected_file = assets/'transcript.corrected.md'
    report_file = assets/'asr-review.md'
    notes_file = assets/'structured-notes.md'
    result = {'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(), 'expectedSegments':len(expected),
              'files':{p.name:p.stat().st_size for p in assets.glob('*') if p.is_file()}}
    if corrected_file.exists():
        actual = segments(corrected_file.read_text())
        identities = [row[0] for row in actual]
        result['correctedSegments'] = len(actual)
        result['exactMetadataAndOrder'] = identities == [row[0] for row in expected]
        result['metadataMismatches'] = [{'position':i,'expected':list(left[0]),'actual':list(right[0])} for i,(left,right) in enumerate(zip(expected,actual)) if left[0]!=right[0]]
        lookup = {key[1]:body for key,body in actual}
        ratios = [(key[1], difflib.SequenceMatcher(None, body, lookup.get(key[1], ''), autojunk=False).ratio()) for key,body in expected]
        result['largeTextChanges'] = [{'order':int(order),'similarity':round(ratio,4)} for order,ratio in ratios if ratio < .8]
        result['meanTextSimilarity'] = round(sum(r for _,r in ratios)/len(ratios),4) if ratios else None
    if report_file.exists():
        report = report_file.read_text()
        result['reviewMarkedComplete'] = bool(re.search(r'^review_status:\s*complete\s*$',report,re.M))
        result['markdownTableCount'] = len(re.findall(r'^\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?', report, re.M))
        result['webLinks'] = sorted(set(re.findall(r'https?://[^\s)<>\]"\u3000-\u303f]+',report)))
    result['hasNotes'] = notes_file.exists() and notes_file.stat().st_size > 0
    result['structurallyComplete'] = bool(result.get('exactMetadataAndOrder') and result.get('reviewMarkedComplete')
                                         and result.get('markdownTableCount') == 2 and result['hasNotes'])
    return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('assets',type=Path)
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[2]/'shared/session-agent/fixtures/nvidia-transcript.md')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args(); result=inspect(args.source,args.assets)
    text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.output:args.output.write_text(text)
    print(text,end='')
