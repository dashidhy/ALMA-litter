"""Validate copied canonical phone publications for the NVIDIA three-revision lane."""
import argparse
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3


def sha(data):
    return hashlib.sha256(data).hexdigest()


def db(path):
    connection = sqlite3.connect(f'file:{path.resolve()}?mode=ro', uri=True)
    if connection.execute('pragma integrity_check').fetchone()[0] != 'ok':
        raise ValueError('Journal integrity failed')
    return connection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    args = parser.parse_args()
    qualification = json.loads((args.run / 'qualification.json').read_text())
    fixture = json.loads(args.fixture.read_text())
    action = qualification['actionID']
    transcript = qualification['transcriptID']
    current = db(args.run / 'tah.sqlite3')
    before = db(args.baseline)
    old = before.execute('select operation_id,stream_id,version,kind,header,payload,sha256 from events').fetchall()
    preserved = all(current.execute('select operation_id,stream_id,version,kind,header,payload,sha256 from events where operation_id=?', (r[0],)).fetchone() == r for r in old)
    publications, documents, imported = {}, {}, []
    for kind, payload in current.execute('select kind,payload from events order by rowid'):
        value = json.loads(payload)
        if kind == 'document' and value.get('transcriptID') == transcript and 'rawTranscript' in value:
            imported.append(value['rawTranscript'])
        if kind == 'publication' and value.get('request', {}).get('actionInstanceID') == action:
            request = value['request']
            publications[request['revisionIndex']] = request
        if kind == 'document' and value.get('phase') == 'completed' and value.get('cycleID') in {p['cycleID'] for p in publications.values()}:
            documents[value['revisionIndex']] = value
    files, revisions = {}, []
    for index, publication in sorted(publications.items()):
        decoded = {}
        for entry in publication['outcome']['entries']:
            if entry['kind'] != 'file':
                continue
            content = base64.b64decode(entry['dataBase64'], validate=True)
            if len(content) != entry['byteLength'] or sha(content) != entry['sha256']:
                raise ValueError('Published bytes differ from manifest')
            content.decode('utf8')
            decoded[entry['relativePath']] = content
        files[index] = decoded
        document = documents[index]
        presentation = document['presentation']
        start = datetime.fromisoformat(presentation['startedAt'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(presentation['endedAt'].replace('Z', '+00:00'))
        events = json.loads(document['workingLog'])['events']
        tools = [e for e in events if e.get('kind') == 'tool']
        revisions.append({'revision': index, 'startedAt': presentation['startedAt'], 'endedAt': presentation['endedAt'],
                          'seconds': (end - start).total_seconds(), 'stages': presentation['stages'],
                          'model': document['inference'], 'webEnabled': document['webEnabled'],
                          'toolCount': len(tools), 'toolFailures': sum(e.get('status') == 'failed' for e in tools),
                          'toolKinds': sorted({e.get('titleCode', e.get('title', 'unknown')) for e in tools}),
                          'critic': publication['critic'], 'actorRounds': publication['actorRounds'],
                          'files': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in decoded.items()}})
    checks = {'driverCompleted': qualification['status'] == 'completed', 'fullTranscriptImported': imported == [fixture['transcript']],
              'allThreePublished': set(publications) == {0, 1, 2}, 'sixReadbacks': len(qualification.get('outcomes', [])) == 6,
              'priorJournalEventsUnchanged': preserved, 'canonicalHashesValid': True}
    if set(files) == {0, 1, 2}:
        notes = [files[i]['structured-notes.md'] for i in range(3)]
        asr = [files[i]['suspicious-asr-terms.md'] for i in range(3)]
        heading = b'## ' + '核心要点'.encode()
        replacement = b'## ' + '内容提要'.encode()
        checks.update(v1OriginalNotesPrefixPreserved=notes[1].startswith(notes[0]),
                      v1HeadingUnique=notes[1].count(heading) == 1,
                      v2ExactRetitle=notes[2] == notes[1].replace(heading, replacement, 1),
                      asrUnchanged=asr[0] == asr[1] == asr[2])
        suffix = notes[1].split(heading)[-1].decode()
        checks['v1FiveTopLevelPoints'] = len(re.findall(r'^[-*+]\s+', suffix, re.M)) == 5
    report = {'provider': qualification['providerID'], 'checks': checks, 'passed': all(checks.values()),
              'transcriptSHA256': sha(fixture['transcript'].encode()), 'baselineEventsChecked': len(old),
              'revisions': revisions, 'scope': 'Canonical integrity, publication, full input and requested edit checks; not an exhaustive factual audit.'}
    (args.run / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
