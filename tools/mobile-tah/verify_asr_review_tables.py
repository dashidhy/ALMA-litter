"""Verify a real model's presentation-only update against the saved prior report."""
import argparse
import hashlib
import html
import json
import re
from pathlib import Path


def original_issues(text):
    matches = list(re.finditer(r'^### (ASR-\d+)\s*$', text, re.M))
    issues = {}
    for index, match in enumerate(matches):
        body = text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)]
        body = re.split(r'^##\s', body, maxsplit=1, flags=re.M)[0]
        location = re.search(r'^- 段：([A-Fa-f0-9-]{36})（Order (\d+)）；采样区间：(\d+)–(\d+)。', body, re.M)
        quote = re.search(r'^- 原文短引：“(.*?)”(?:；采用：“(.*?)”)?。\s*$', body, re.M)
        if not location or not quote:
            raise ValueError('Unrecognized original issue: ' + match[1])
        issues[match[1]] = {'segment': location[1], 'start': location[3], 'end': location[4],
                           'original': quote[1], 'correction': quote[2],
                           'urls': re.findall(r'https?://[^\s)\]。]+', body)}
    if not issues:
        raise ValueError('No original issues found')
    return issues


def cells(line):
    return [html.unescape(value.strip().replace(r'\|', '|').replace(r'\\', '\\'))
            for value in re.split(r'(?<!\\)\|', line.strip().strip('|'))]


def verify(before, after):
    old = original_issues(before)
    headings = re.findall(r'^#{1,2}\s+(.+)', after, re.M)
    expected = [
        ['编号', '可疑原文', '原转写定位', '未解决的歧义'],
        ['编号', '原文', '采用的纠正', '原转写定位', '解决来源与依据'],
    ]
    tables = []
    for line in after.splitlines():
        if not line.startswith('|'):
            continue
        row = cells(line)
        if row in expected:
            tables.append({'headers': row, 'rows': []})
        elif tables and not all(re.fullmatch(r':?-+:?', c) for c in row):
            tables[-1]['rows'].append(row)
    failures = []
    if [table['headers'] for table in tables] != expected:
        failures.append('Expected unresolved table then resolved table with the agreed columns')
    seen = []
    for table in tables:
        resolved = table['headers'] == expected[1]
        for row in table['rows']:
            if len(row) != len(table['headers']):
                failures.append('Wrong number of cells: ' + repr(row[:1]))
                continue
            issue_id = re.sub(r'[`*_]', '', row[0]).strip()
            seen.append(issue_id)
            issue = old.get(issue_id)
            if not issue:
                failures.append('Unexpected issue: ' + issue_id)
                continue
            if resolved != (issue['correction'] is not None):
                failures.append('Classification changed: ' + issue_id)
            location = row[3] if resolved else row[2]
            if any(value not in location for value in (issue['segment'], issue['start'], issue['end'])):
                failures.append('Source locator changed: ' + issue_id)
            if issue['original'] not in row[1]:
                failures.append('Original wording changed: ' + issue_id)
            if resolved:
                if issue['correction'] not in row[2]:
                    failures.append('Adopted correction changed: ' + issue_id)
                if 'Agent' not in row[4] or '用户确认' in row[4]:
                    failures.append('Correction attribution changed: ' + issue_id)
                if any(url not in row[4] for url in issue['urls']):
                    failures.append('Evidence URL missing: ' + issue_id)
    if len(seen) != len(set(seen)) or set(seen) != set(old):
        failures.append('Issue IDs were lost, duplicated or added')
    if re.search(r'^###\s+ASR-\d+', after, re.M):
        failures.append('Per-issue headings remain')
    if not re.search(r'^review_status:\s*[\"\x27]?complete[\"\x27]?\s*$', after, re.M):
        failures.append('Completed review metadata missing')
    return {'passed': not failures, 'failures': failures, 'issueCount': len(seen),
            'tableRows': [len(t['rows']) for t in tables], 'headings': headings,
            'beforeSHA256': hashlib.sha256(before.encode()).hexdigest(),
            'afterSHA256': hashlib.sha256(after.encode()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.before.read_text(), args.after.read_text())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['passed'] else 1)
