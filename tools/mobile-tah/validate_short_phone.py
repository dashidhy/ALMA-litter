#!/usr/bin/env python3
"""Offline canonical validation of the short mobile qualification fixture.

Examples (no device/network access):
  python3 validate_short.py --run /path/kimi-short --baseline /path/before.sqlite3 --provider kimi
  python3 validate_short.py --run /path/codex-short --baseline /path/before.sqlite3 --provider codex
  python3 validate_short.py --self-test

--run contains qualification.json and either journal/tah.sqlite3 or tah.sqlite3.
Override --db/--qualification when the evidence lives elsewhere. DB+WAL are read
from private temporary copies; original databases/SHM/reports are never opened
writable. Output defaults to RUN/short-validation.json and is create-only.

Exit 0: machine checks passed (manual review can STILL be pending).
Exit 1: a check/manual review failed. Exit 2: incomplete/unreadable evidence.
No overall acceptance is reported until a hash-bound --manual-review is supplied.
This fixture requires preservation of facts, NOT identical wording or ASR bytes.
Readbacks hash rendered text; they are never equated to canonical Markdown hashes.
"""
import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import difflib
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest

FILES = ("structured-notes.md", "suspicious-asr-terms.md")
HEX = re.compile(r"[0-9a-f]{64}\Z")
MANUAL_ITEMS = {
    "chinese_output": "Notes and ASR are actually Chinese; required English subsection titles/terms may remain English.",
    "v0_source_fidelity": "V0 accurately attributes the synthetic source, 3 batches of 4, source claim 14, foreground/background, and no reported accuracy; no invented facts.",
    "v1_corrected_12": "V1 gives 12 = 3 × 4 as the correct total and explicitly labels the arithmetic correction as user-provided.",
    "v1_attributed_14": "V1 retains 14 as the original attributed source claim, not the corrected or verified total.",
    "v2_title_and_correction": "V2 uses Arithmetic correction in place of the Batch count subsection while retaining 12, user correction attribution, and attributed original 14.",
    "other_facts_preserved": "Across revisions foreground/background labels, 3 × 4 and absence of accuracy measurement remain correct; other notes facts are preserved despite rewording.",
    "asr_fact_consistency": "Both required files remain; ASR treatment is consistent with the source and does not turn a deliberate arithmetic typo into an ASR fact. Byte identity is not required.",
    "no_online_verification_claim": "No revision claims online verification; explicit statements that no online verification occurred are allowed.",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(data):
    return {"bytes": len(data), "sha256": sha(data)}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def fingerprint(path):
    return identity(path.read_bytes()) if path.is_file() else None


def fixture_default():
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tools/mobile-tah/fixtures/mobile-qualification-fixture.json"
        if candidate.is_file():
            return candidate
    return None


def load_tracked(path, sources):
    data = path.read_bytes()
    sources[str(path)] = identity(data)
    return json.loads(data)


def copy_database(source, directory, label, sources):
    """Freeze a DB/WAL set before SQLite can touch even a shared-memory sidecar."""
    source = source.resolve()
    if not source.is_file():
        raise ValueError(f"Missing database: {source}")
    paths = [Path(str(source) + suffix) for suffix in ("", "-wal", "-shm")]
    captured = {path: path.read_bytes() if path.exists() else None for path in paths}
    destination = directory / label
    destination.mkdir()
    for path, data in captured.items():
        sources[str(path)] = identity(data) if data is not None else None
        if data is not None and not str(path).endswith("-shm"):
            suffix = str(path)[len(str(source)):]
            (destination / ("tah.sqlite3" + suffix)).write_bytes(data)
    if any(fingerprint(path) != sources[str(path)] for path in paths):
        raise ValueError(f"Database or sidecar changed during copy: {source}")
    connection = sqlite3.connect((destination / "tah.sqlite3").as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def read_events(connection):
    result = []
    for row in connection.execute("SELECT rowid AS event_rowid,* FROM events ORDER BY rowid"):
        event = dict(row)
        event["value"] = json.loads(event["payload"])
        event["header_value"] = json.loads(event["header"])
        result.append(event)
    return result


def ref(event):
    return {"rowid": event["event_rowid"], "operationID": event["operation_id"],
            "streamID": event["stream_id"], "version": event["version"],
            "kind": event["kind"], "header": identity(event["header"]), "payload": identity(event["payload"])}


def event_valid(event):
    h = event["header_value"]
    return (sha(event["payload"]) == event["sha256"] == h.get("sha256")
            and len(event["payload"]) == h.get("byteLength")
            and h.get("expectedVersion") == event["version"] - 1
            and h.get("operationID") == event["operation_id"]
            and h.get("streamID") == event["stream_id"] and h.get("kind") == event["kind"])


def candidate_digest(outcome):
    value = b"ALMA_TAH_CANDIDATE_V1\0" + outcome["writableRoot"].encode() + b"\0"
    for entry in outcome["entries"]:
        value += entry["kind"].encode() + b"\0" + entry["relativePath"].encode() + b"\0"
        if entry["kind"] == "file":
            value += str(entry["byteLength"]).encode() + b"\0" + entry["sha256"].encode()
        value += b"\0"
    return sha(value)


def decode_outcome(outcome, revision):
    entries = outcome["entries"]
    if outcome["writableRoot"] != f"outbox/revision_v{revision}":
        raise ValueError("Incorrect writableRoot")
    if [entry["relativePath"] for entry in entries] != list(FILES):
        raise ValueError("Outcome must contain exactly two canonically ordered required files")
    decoded = {}
    for entry in entries:
        if entry["kind"] != "file":
            raise ValueError("Required output is not a file")
        data = base64.b64decode(entry["dataBase64"], validate=True)
        data.decode("utf-8", errors="strict")
        if (not data or len(data) != entry["byteLength"] or sha(data) != entry["sha256"]
                or base64.b64encode(data).decode() != entry["dataBase64"]):
            raise ValueError("Published UTF-8 bytes/base64/length/hash invalid")
        decoded[entry["relativePath"]] = data
    if candidate_digest(outcome) != outcome["candidateDigest"]:
        raise ValueError("Candidate digest mismatch")
    return decoded


def render_ledger(ledger):
    sections = []
    quote = lambda text: "\n".join("> " + line for line in text.split("\n"))
    for entry in ledger:
        parts = [f"## revision v{entry['revisionIndex']}", "",
                 "N/A" if entry["initial"] is None else quote(entry["initial"])]
        for index, retry in enumerate(entry["retries"]):
            parts += ["", f"### Retry instruction {index + 1}", "", quote(retry)]
        sections.append("\n".join(parts))
    return ("# Extra Instructions\n\n" + "\n\n".join(sections) + "\n").encode()


def is_web(event):
    if event.get("kind") != "tool":
        return False
    if event.get("titleCode") == "tool.web":
        return True
    text = event.get("title", "") + " " + event.get("detail", "")
    return bool(re.search(r"\b(?:WebSearch|WebFetch|FetchURL|web_search|web_fetch|web\.run)\b|^Web access\b", text, re.I))


def headings(text):
    """Display headings only; ignore fenced examples and ordinary references."""
    found, fence, previous = [], None, ""
    for number, line in enumerate(text.splitlines(), 1):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            char = marker[1][0]
            fence = None if fence == char else char if fence is None else fence
            previous = ""
            continue
        if fence is not None:
            continue
        match = re.match(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if match:
            title = match[2].strip().strip("*`_").strip()
            found.append({"level": len(match[1]), "title": title, "line": number})
        elif previous.strip() and re.fullmatch(r" {0,3}(?:={3,}|-{3,})\s*", line):
            found.append({"level": 1 if "=" in line else 2, "title": previous.strip(), "line": number - 1})
        previous = line
    return found


def timing(presentation):
    parse = lambda text: datetime.fromisoformat(text.replace("Z", "+00:00"))
    duration = lambda a, b: round((parse(b) - parse(a)).total_seconds(), 6)
    stages = []
    for index, stage in enumerate(presentation["stages"]):
        end = presentation["stages"][index + 1]["at"] if index + 1 < len(presentation["stages"]) else presentation["endedAt"]
        stages.append({**stage, "endedAt": end, "seconds": duration(stage["at"], end)})
    return {"startedAt": presentation["startedAt"], "endedAt": presentation["endedAt"],
            "totalSeconds": duration(presentation["startedAt"], presentation["endedAt"]), "stages": stages}


def readback_analysis(outcomes):
    pairs, records, errors = [], [], []
    for item in outcomes:
        pair = (item.get("revision"), item.get("file"))
        pairs.append(pair)
        data = item.get("sanitizedText", "").encode()
        valid = (isinstance(item.get("renderedUTF8Bytes"), int) and item["renderedUTF8Bytes"] > 0
                 and bool(HEX.fullmatch(item.get("renderedSHA256", ""))) and bool(data)
                 and isinstance(item.get("textTruncated"), bool))
        can_check = item.get("textTruncated") is False and "[redacted]" not in item.get("sanitizedText", "")
        matches = (identity(data) == {"bytes": item.get("renderedUTF8Bytes"), "sha256": item.get("renderedSHA256")}) if can_check else None
        if not valid or matches is False:
            errors.append(pair)
        records.append({**item, "metadataValid": valid, "sanitizedTextHashCheck": matches,
                        "hashDomain": "Rendered UI text, not canonical Markdown"})
    exact = len(pairs) == 6 and set(pairs) == {(index, name) for index in range(3) for name in FILES}
    return {"sixUniqueReadbacks": exact, "valid": not errors, "records": records,
            "unverifiableSanitizedHashes": sum(x["sanitizedTextHashCheck"] is None for x in records),
            "note": "Sanitized/truncated text cannot reconstruct its original rendered hash. Never compare rendered hashes to published Markdown hashes."}


def critic_valid(publication, proposal):
    critic = publication["critic"]
    rounds = publication["criticRounds"]
    attempts = publication["actorAttempts"]
    count = publication["actorRounds"]
    digest = publication["outcome"]["candidateDigest"]
    return (count in (1, 2) and len(rounds) == len(attempts) == count
            and [x["round"] for x in rounds] == [x["round"] for x in attempts] == list(range(count))
            and len({x["attemptID"] for x in attempts}) == count
            and all(x["inference"] == proposal["actorInference"] for x in attempts)
            and critic == rounds[-1]["result"] and critic["decision"] == "PASS"
            and critic["candidateDigest"] == digest and critic.get("issues") == []
            and all(x["result"]["contractID"] == proposal["actorInput"]["outcomeContractID"] for x in rounds)
            and (count == 1 or rounds[0]["result"]["decision"] == "REJECT" and rounds[0]["result"]["candidateDigest"] != digest))


def bindings(action, fixture_bytes, decoded):
    return {"actionID": action, "fixtureSHA256": sha(fixture_bytes),
            "files": {f"v{index}/{name}": identity(data) for index, files in decoded.items() for name, data in files.items()}}


def manual_status(review, expected_bindings):
    template = {"reviewer": "", "bindings": expected_bindings,
                "items": [{"id": key, "requirement": requirement, "status": "pending", "evidence": ""}
                          for key, requirement in MANUAL_ITEMS.items()]}
    if review is None:
        return {"status": "pending", "passed": None, "template": template}
    items = review.get("items", [])
    valid = (review.get("bindings") == expected_bindings and bool(review.get("reviewer"))
             and len(items) == len(MANUAL_ITEMS) and {x.get("id") for x in items} == set(MANUAL_ITEMS)
             and all(x.get("status") in ("pass", "fail") and bool(x.get("evidence", "").strip()) for x in items))
    passed = valid and all(x["status"] == "pass" for x in items)
    return {"status": "passed" if passed else "failed" if valid else "invalid_review", "passed": passed,
            "bindingsAndChecklistValid": valid, "review": review, "template": template}


def validate(args, temporary):
    sources, checks = {}, {}
    qualification_path = args.qualification or args.run / "qualification.json"
    q = load_tracked(qualification_path, sources)
    fixture = load_tracked(args.fixture, sources)
    fixture_bytes = args.fixture.read_bytes()
    action, transcript = q["actionID"], q["transcriptID"]
    provider = args.provider or q["providerID"]
    database = args.db
    if database is None:
        candidates = [p for p in (args.run / "journal/tah.sqlite3", args.run / "tah.sqlite3") if p.is_file()]
        if len(candidates) != 1:
            raise ValueError("Specify --db: expected exactly one RUN/journal/tah.sqlite3 or RUN/tah.sqlite3")
        database = candidates[0]
    baseline_path = args.baseline / "tah.sqlite3" if args.baseline.is_dir() else args.baseline
    current = copy_database(database, temporary, "current", sources)
    baseline = copy_database(baseline_path, temporary, "baseline", sources)
    try:
        checks["sqliteIntegrity"] = all(c.execute("PRAGMA integrity_check").fetchone()[0] == "ok" for c in (current, baseline))
        events, old = read_events(current), read_events(baseline)
        event_map = {e["operation_id"]: e for e in events}
        columns = [row[1] for row in baseline.execute("PRAGMA table_info(events)")]
        differences = [{"operationID": e["operation_id"], "differentColumns": [key for key in columns if e["operation_id"] not in event_map or e[key] != event_map[e["operation_id"]][key]]} for e in old]
        differences = [x for x in differences if x["differentColumns"]]
        checks["baselineEventsUnchanged"] = bool(old) and not differences
        if args.expected_baseline_events is not None:
            checks["baselineEventCountMatchesExpected"] = len(old) == args.expected_baseline_events
        checks["allEventPayloadHashesValid"] = all(event_valid(e) for e in events + old)
        checks["driverCompleted"] = q.get("status") == "completed" and q.get("stage") == "completed" and not q.get("failureCode") and q.get("needsUserUnlocked") is False and q.get("workflowMayStillBeRunning") is False
        checks["providerMatches"] = q.get("providerID") == provider
        checks["fixtureShortDefaults"] = fixture.get("outputLanguage") == fixture.get("interactionLanguage") == "zh-CN" and fixture.get("webEnabled") is False and len(fixture.get("deltas", [])) == 3 and fixture["deltas"][0] == ""
        readbacks = readback_analysis(q.get("outcomes", []))
        checks["sixReadbacks"] = readbacks["sixUniqueReadbacks"]
        checks["readbackMetadataAndCheckableRenderedHashesValid"] = readbacks["valid"]
        owner_events = [e for e in events if e["header_value"].get("ownerID") == "transcript/" + transcript]
        imports = [e for e in owner_events if e["kind"] == "document" and e["value"].get("transcriptID") == transcript and "rawTranscript" in e["value"]]
        checks["fullFixtureTranscriptImported"] = len(imports) == 1 and imports[0]["value"]["rawTranscript"] == fixture["transcript"]
        grouped = {kind: [e for e in owner_events if e["kind"] == kind and e["value"].get("request", {}).get("actionInstanceID") == action] for kind in ("proposal", "publication")}
        operations = [e for e in owner_events if e["stream_id"] == "operation/" + action]
        completed = [e for e in operations if e["value"].get("phase") == "completed"]
        checks["exactlyV0V1V2Published"] = sorted(e["value"]["request"]["revisionIndex"] for e in grouped["publication"]) == [0, 1, 2]
        checks["exactlyV0V1V2Completed"] = sorted(e["value"]["revisionIndex"] for e in completed) == [0, 1, 2]
        revisions, decoded = [], {}
        for index in range(3):
            pubs = [e for e in grouped["publication"] if e["value"]["request"]["revisionIndex"] == index]
            if len(pubs) != 1:
                checks[f"v{index}.uniquePublication"] = False
                continue
            pe = pubs[0]
            p = pe["value"]["request"]
            proposals = [e for e in grouped["proposal"] if e["value"]["request"]["cycleID"] == p["cycleID"]]
            docs = [e for e in completed if e["value"]["cycleID"] == p["cycleID"]]
            checks[f"v{index}.matchingProposalAndCompletedOperation"] = len(proposals) == len(docs) == 1
            if not checks[f"v{index}.matchingProposalAndCompletedOperation"]:
                continue
            qe, de = proposals[0], docs[0]
            proposal, doc = qe["value"]["request"], de["value"]
            try:
                files = decode_outcome(p["outcome"], index)
                decoded[index] = files
                checks[f"v{index}.publishedBytesHashesCandidateValid"] = True
            except (ValueError, KeyError, TypeError, UnicodeError) as error:
                checks[f"v{index}.publishedBytesHashesCandidateValid"] = False
                revisions.append({"revision": index, "error": str(error)})
                continue
            checks[f"v{index}.commitAndOutcomeLinks"] = (doc["result"]["outcome"] == p["outcome"]
                and doc["result"]["publicationCommitID"] == pe["value"]["result"]["commitID"]
                and p["proposalCommitID"] == doc["result"]["proposalCommitID"] == qe["value"]["result"]["commitID"])
            checks[f"v{index}.criticPassAndRounds"] = critic_valid(p, proposal)
            actor_input = proposal["actorInput"]
            checks[f"v{index}.effectiveSettings"] = (doc["providerID"] == proposal["providerID"] == p["providerID"] == provider
                and doc["inference"] == proposal["actorInference"]
                and doc["actionLanguage"] == actor_input["language"] == fixture["outputLanguage"]
                and doc["interactionLanguage"] == actor_input["interactionLanguage"] == fixture["interactionLanguage"]
                and doc["webEnabled"] is False and proposal["webEnabled"] is False)
            for key, expected in (("modelID", args.expected_model), ("reasoningEffortID", args.expected_effort)):
                if expected is not None:
                    checks[f"v{index}.expected{key}"] = doc["inference"].get(key) == expected
            if "modelIDs" in fixture:
                checks[f"v{index}.fixtureModel"] = doc["inference"]["modelID"] == fixture["modelIDs"][index]
            if "efforts" in fixture:
                checks[f"v{index}.fixtureEffort"] = doc["inference"]["reasoningEffortID"] == fixture["efforts"][index]
            ledger = proposal["ledger"]
            expected_ledger = [{"revisionIndex": i, "initial": fixture["deltas"][i] or None, "retries": []} for i in range(index + 1)]
            checks[f"v{index}.fullInstructionsAndLedger"] = ledger == p["ledger"] == doc["result"]["admittedLedger"] == expected_ledger and doc["instructions"] == fixture["deltas"][index]
            material = render_ledger(ledger)
            checks[f"v{index}.actorInputIdentity"] = actor_input["rawTranscript"] == {"byteLength": len(fixture["transcript"].encode()), "sha256": sha(fixture["transcript"].encode())} and actor_input["extraInstructions"] == {"byteLength": len(material), "sha256": sha(material)}
            previous = sorted([e for e in grouped["publication"] if e["value"]["request"]["revisionIndex"] < index], key=lambda e: e["value"]["request"]["revisionIndex"])
            prior = [{"revisionIndex": e["value"]["request"]["revisionIndex"], "publicationCommitID": e["value"]["result"]["commitID"], "candidateDigest": e["value"]["request"]["outcome"]["candidateDigest"]} for e in previous]
            checks[f"v{index}.canonicalBaseChain"] = actor_input["acceptedRevisions"] == prior and actor_input["basePublication"] == (prior[-1] if prior else None)
            log_bytes = doc["workingLog"].encode()
            log = json.loads(log_bytes)
            pres = doc["presentation"]
            tools = [e for e in log["events"] if e["kind"] == "tool"]
            web = [e for e in tools if is_web(e)]
            checks[f"v{index}.completeWorkingLogHash"] = (identity(log_bytes) == {"bytes": pres["workingLogBytes"], "sha256": pres["workingLogSHA256"]}
                and log["limited"] is False and pres["workingLogLimited"] is False and len({e["id"] for e in tools}) == len(tools))
            checks[f"v{index}.noWebRecorded"] = not web
            safety = proposal["safety"]
            guardian_event = [e for e in log["events"] if e.get("id") == "extra-safety-pass" and e.get("role") == "extra_guardian" and e.get("status") == "pass"]
            checks[f"v{index}.extraGuardianAdmission"] = safety == {"kind": "skipped_initial_v0"} if index == 0 else (safety.get("kind") in ("extra_guardian_pass", "extra_guardian_allow")
                and bool(safety.get("attemptID")) and bool(safety.get("inference", {}).get("modelID"))
                and bool(safety.get("inference", {}).get("reasoningEffortID"))
                and (safety["kind"] == "extra_guardian_pass" or safety.get("assessment", {}).get("decision") == "ALLOW")
                and len(guardian_event) == 1 and any(s["phase"] == "extra_guardian" for s in pres["stages"]))
            notes = files[FILES[0]].decode()
            title_list = headings(notes)
            if index in (1, 2):
                desired = "Batch count" if index == 1 else "Arithmetic correction"
                checks[f"v{index}.requiredSubsectionTitle"] = sum(h["title"] == desired and h["level"] >= 2 for h in title_list) == 1
            if index == 2:
                checks["v2.noOldBatchCountHeading"] = all(h["title"] != "Batch count" for h in title_list)
            duration = timing(pres)
            checks[f"v{index}.timingOrderedAndComplete"] = all(s["seconds"] >= 0 for s in duration["stages"]) and abs(sum(s["seconds"] for s in duration["stages"]) - duration["totalSeconds"]) < 0.000001
            failures = [e for e in tools if e["status"] == "failed"]
            names = Counter(e.get("titleCode", e["title"]) for e in tools)
            revisions.append({"revision": index, "cycleID": p["cycleID"], "publication": ref(pe), "proposal": ref(qe), "completedOperation": ref(de),
                "files": {name: {**identity(data), "text": data.decode()} for name, data in files.items()},
                "candidateDigest": p["outcome"]["candidateDigest"], "critic": p["critic"], "criticRounds": p["criticRounds"],
                "actorAttempts": p["actorAttempts"], "extraGuardian": safety, "extraGuardianVerdicts": guardian_event,
                "effectiveSettings": {"providerID": provider, "inference": doc["inference"], "outputLanguage": doc["actionLanguage"], "interactionLanguage": doc["interactionLanguage"], "webEnabled": doc["webEnabled"]},
                "instructions": doc["instructions"], "timing": duration, "workingLogIdentity": identity(log_bytes),
                "tools": {"count": len(tools), "kinds": dict(sorted(names.items())), "failedCount": len(failures), "failures": failures, "webCount": len(web), "webEvents": web,
                          "operationError": doc.get("error"), "events": tools, "notices": [e for e in log["events"] if e["kind"] == "notice"]},
                "headings": title_list, "factSignalsForReviewOnly": {"contains12Digits": bool(re.search(r"(?<!\d)12(?!\d)", notes)), "contains14Digits": bool(re.search(r"(?<!\d)14(?!\d)", notes)),
                    "excerpts": [line for line in notes.splitlines() if re.search(r"12|14|前景|背景|准确|精度|用户|foreground|background|accuracy|user", line, re.I)]}})
        stream = current.execute("SELECT * FROM streams WHERE id=?", ("action/" + action,)).fetchone()
        checks["acceptedRevisionV2"] = stream is not None and stream["accepted_revision"] == 2 and stream["deleted"] == 0
        raw = [e for e in owner_events if e["stream_id"].startswith("raw/" + transcript + "/")]
        latest_raw = {e["stream_id"]: e for e in raw}
        if args.raw_key:
            latest_raw = {key: value for key, value in latest_raw.items() if key.endswith("/" + args.raw_key)}
        receipts = list(latest_raw.values())
        raw_checks = []
        if len(receipts) == 1:
            receipt = receipts[0]
            raw_checks = [e for e in owner_events if e["stream_id"] == receipt["stream_id"].replace("raw/", "raw-check/", 1)]
            checks["rawGuardianAllowed"] = receipt["value"].get("allowed") is True and receipt["value"].get("assessment", {}).get("decision") == "ALLOW" and receipt["value"].get("interactionLanguage") == "zh-CN"
            checks["rawGuardianCompletedBeforeProposal"] = bool(raw_checks) and raw_checks[-1]["value"].get("phase") == "completed" and raw_checks[-1]["value"].get("errorCode") is None and bool(grouped["proposal"]) and raw_checks[-1]["event_rowid"] < min(e["event_rowid"] for e in grouped["proposal"])
        else:
            checks["rawGuardianAllowed"] = checks["rawGuardianCompletedBeforeProposal"] = False
        raw_steps = [s for s in q.get("steps", []) if s["stage"] == "raw_check"]
        ready = [s for s in raw_steps if not s["state"]["busy"] and s["state"]["canCreateAction"]]
        raw_duration = round(ready[-1]["elapsedSeconds"] - raw_steps[0]["elapsedSeconds"], 9) if ready else None
        complete_revisions = [r for r in revisions if "timing" in r]
        stage_totals, tool_totals = Counter(), Counter()
        for revision in complete_revisions:
            tool_totals.update(revision["tools"]["kinds"])
            for stage in revision["timing"]["stages"]:
                stage_totals[stage["phase"]] += stage["seconds"]
        revision_seconds = round(sum(r["timing"]["totalSeconds"] for r in complete_revisions), 6)
        summary = {"driverTotalSeconds": q.get("elapsedSeconds"), "revisionTotalSeconds": revision_seconds,
                   "rawObservedSeconds": raw_duration,
                   "rawPlusRevisionSeconds": round(raw_duration + revision_seconds, 6) if raw_duration is not None else None,
                   "stageSeconds": {key: round(value, 6) for key, value in sorted(stage_totals.items())},
                   "toolCount": sum(r["tools"]["count"] for r in complete_revisions),
                   "toolFailureCount": sum(r["tools"]["failedCount"] for r in complete_revisions),
                   "operationErrorCount": sum(r["tools"]["operationError"] is not None for r in complete_revisions),
                   "providerNoticeCount": sum(len(r["tools"]["notices"]) for r in complete_revisions),
                   "recordedWebToolCount": sum(r["tools"]["webCount"] for r in complete_revisions),
                   "toolKinds": dict(sorted(tool_totals.items())),
                   "timingScope": "Revision wall-clock stage intervals plus sampled Raw duration; driver total additionally includes setup/readbacks/between-revision gaps. Actor includes provider/tool time."}
        checks["driverFinalModelMatchesV2"] = 2 in decoded and any(r.get("revision") == 2 and r.get("effectiveSettings", {}).get("inference") == {"modelID": q.get("modelID"), "reasoningEffortID": q.get("reasoningEffortID")} for r in revisions)
        manual = load_tracked(args.manual_review, sources) if args.manual_review else None
        review = manual_status(manual, bindings(action, fixture_bytes, decoded))
        observer = load_tracked(args.run / "observer.json", sources) if (args.run / "observer.json").is_file() else None
        checks["originalEvidenceFilesUnchanged"] = all(fingerprint(Path(path)) == data for path, data in sources.items())
        failed = [name for name, result in checks.items() if not result]
        incomplete = not checks["driverCompleted"] or not checks["exactlyV0V1V2Published"] or not checks["exactlyV0V1V2Completed"]
        machine_passed = not failed
        accepted = False if failed or review["passed"] is False else True if review["passed"] is True else None
        status = "incomplete" if incomplete else "machine_failed" if failed else "manual_review_failed" if review["passed"] is False else "accepted" if accepted else "machine_passed_manual_review_required"
        diffs = []
        for first, second in ((0, 1), (1, 2)):
            if first in decoded and second in decoded:
                diffs.append({"from": first, "to": second, "notesDiff": "".join(difflib.unified_diff(decoded[first][FILES[0]].decode().splitlines(True), decoded[second][FILES[0]].decode().splitlines(True), fromfile=f"V{first}", tofile=f"V{second}")),
                              "asrByteIdenticalInformationalOnly": decoded[first][FILES[1]] == decoded[second][FILES[1]]})
        return {"schemaVersion": 1, "status": status, "machinePassed": machine_passed, "acceptancePassed": accepted,
                "actionID": action, "transcriptID": transcript, "providerID": provider, "machineChecks": checks, "failedChecks": failed,
                "scope": "Offline canonical integrity and recorded execution. Facts and semantic preservation require separate hash-bound review; no full-text/ASR byte equality requirement.",
                "fixture": {"path": str(args.fixture), **identity(fixture_bytes), "transcript": identity(fixture["transcript"].encode()), "text": fixture["transcript"], "deltas": fixture["deltas"]},
                "driver": {key: q.get(key) for key in ("status", "stage", "startedAt", "elapsedSeconds", "providerID", "modelID", "reasoningEffortID", "failureCode")},
                "observer": observer, "readbacks": readbacks, "sources": sources,
                "baseline": {"path": str(baseline_path), "eventsChecked": len(old), "eventsUnchanged": len(old) - len(differences), "columnsCompared": columns, "differences": differences},
                "database": {"path": str(database), "events": len(events), "readMethod": "Private temporary copies of database + WAL; original SHM fingerprinted but never opened by SQLite; absent sidecars tracked."},
                "rawGuardian": {"receipts": [{**ref(e), "value": e["value"]} for e in receipts], "checks": [{**ref(e), "value": e["value"]} for e in raw_checks],
                                "observedStageSeconds": raw_duration, "model": None, "modelOnlySeconds": None,
                                "limitation": "Receipt binds transcript/cache key and verdict; Raw model and exact inference time are not retained. Multiple cache keys require explicit --raw-key. No zero-call claim is made for unlogged Guardian internals."},
                "revisions": revisions, "executionSummary": summary, "diffsInformationalOnly": diffs, "manualFactReview": review,
                "limitations": ["No Web recorded means no Web tool event in complete retained Actor logs, not proof of absence of every network request.", "Rendered readbacks and canonical Markdown have separate hash domains.", "Critic PASS verifies its recorded contract decision, not the full factual checklist.", "Literal required subsection headings are machine checked; meaning, number attribution and other facts are reviewed separately."],
                "validator": {"path": str(Path(__file__).resolve()), **identity(Path(__file__).read_bytes())}}
    finally:
        current.close()
        baseline.close()


def self_test():
    class OfflineTests(unittest.TestCase):
        def test_publication_bytes(self):
            entries = [{"kind": "file", "relativePath": name, "byteLength": 3, "sha256": sha(b"abc"), "dataBase64": "YWJj"} for name in FILES]
            outcome = {"writableRoot": "outbox/revision_v1", "entries": entries}
            outcome["candidateDigest"] = candidate_digest(outcome)
            self.assertEqual(set(decode_outcome(outcome, 1)), set(FILES))
            entries[0]["dataBase64"] = "YWJk"
            with self.assertRaises(ValueError):
                decode_outcome(outcome, 1)

        def test_web_variants_and_file_search(self):
            for value in ("WebSearch: done", "FetchURL: done", "web_search", "WebFetch: done"):
                self.assertTrue(is_web({"kind": "tool", "detail": value}))
            self.assertTrue(is_web({"kind": "tool", "titleCode": "tool.web"}))
            self.assertFalse(is_web({"kind": "tool", "titleCode": "tool.text_search", "title": "Search files"}))
            self.assertFalse(is_web({"kind": "activity", "detail": "No WebSearch was used"}))

        def test_headings_not_references(self):
            text = "### Arithmetic correction\nChanged from Batch count.\n```md\n## Batch count\n```\n"
            self.assertEqual([x["title"] for x in headings(text)], ["Arithmetic correction"])
            self.assertEqual(headings("Batch count\n-----------\n")[0]["title"], "Batch count")

        def test_readbacks_separate_hash_domain(self):
            records = [{"revision": i, "file": name, "sanitizedText": "UI", "textTruncated": False,
                        "renderedUTF8Bytes": 2, "renderedSHA256": sha(b"UI")} for i in range(3) for name in FILES]
            self.assertTrue(readback_analysis(records)["valid"])
            self.assertTrue(readback_analysis(records)["sixUniqueReadbacks"])
            records[-1] = records[0]
            self.assertFalse(readback_analysis(records)["sixUniqueReadbacks"])

        def test_manual_review_cannot_pass_on_keyword_signals(self):
            binding = {"actionID": "example", "files": {}}
            self.assertIsNone(manual_status(None, binding)["passed"])
            review = {"reviewer": "tester", "bindings": binding,
                      "items": [{"id": key, "status": "pass", "evidence": "reviewed"} for key in MANUAL_ITEMS]}
            self.assertTrue(manual_status(review, binding)["passed"])
            self.assertFalse(manual_status(review, {"actionID": "different"})["passed"])

        def test_wal_is_included_without_mutating_source(self):
            with tempfile.TemporaryDirectory() as name:
                root = Path(name)
                source = root / "source.sqlite3"
                writer = sqlite3.connect(source)
                try:
                    writer.execute("PRAGMA journal_mode=WAL")
                    writer.execute("CREATE TABLE sample(value TEXT)")
                    writer.commit()
                    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    writer.execute("INSERT INTO sample VALUES ('only in WAL')")
                    writer.commit()
                    sources = {}
                    copied = copy_database(source, root, "copy", sources)
                    try:
                        self.assertEqual(copied.execute("SELECT value FROM sample").fetchone()[0], "only in WAL")
                        self.assertTrue(all(fingerprint(Path(path)) == meta for path, meta in sources.items()))
                    finally:
                        copied.close()
                finally:
                    writer.close()
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(OfflineTests))
    return 0 if result.wasSuccessful() else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", type=Path, help="Copied final evidence directory")
    parser.add_argument("--baseline", type=Path, help="Pre-run database or directory containing tah.sqlite3")
    parser.add_argument("--fixture", type=Path, default=fixture_default())
    parser.add_argument("--db", type=Path, help="Explicit copied final database (WAL honored)")
    parser.add_argument("--qualification", type=Path, help="Explicit driver qualification.json")
    parser.add_argument("--provider", help="Expected provider ID, e.g. kimi or codex; no model hardcoding")
    parser.add_argument("--expected-model")
    parser.add_argument("--expected-effort")
    parser.add_argument("--expected-baseline-events", type=int)
    parser.add_argument("--raw-key", help="Exact Raw receipt cache key if multiple candidates exist")
    parser.add_argument("--manual-review", type=Path, help="Completed hash-bound manualFactReview.template JSON")
    parser.add_argument("--output", type=Path, help="New report path, default RUN/short-validation.json; never overwritten")
    parser.add_argument("--self-test", action="store_true", help="Only synthetic helper tests; no qualification evidence read")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.run is None or args.baseline is None or args.fixture is None:
        parser.error("--run, --baseline and a discoverable/explicit --fixture are required")
    for key in ("run", "baseline", "fixture", "db", "qualification", "manual_review", "output"):
        value = getattr(args, key)
        if value is not None:
            setattr(args, key, value.resolve())
    output = args.output or args.run / "short-validation.json"
    if output.exists():
        parser.error(f"Output exists; use a new --output path: {output}")
    try:
        with tempfile.TemporaryDirectory(prefix="tah-short-offline-") as name:
            report = validate(args, Path(name))
    except (OSError, ValueError, KeyError, TypeError, IndexError, sqlite3.Error) as error:
        report = {"schemaVersion": 1, "status": "evidence_error", "machinePassed": False,
                  "acceptancePassed": False, "error": f"{type(error).__name__}: {error}"}
    # Never create missing run directories; a mistaken path must fail visibly.
    with output.open("xb") as handle:
        handle.write(json_bytes(report))
    print(json.dumps({"output": str(output), "status": report["status"], "machinePassed": report["machinePassed"],
                      "acceptancePassed": report["acceptancePassed"], "failedChecks": report.get("failedChecks", []), "error": report.get("error")}, ensure_ascii=False, indent=2))
    if report["status"] in ("incomplete", "evidence_error"):
        return 2
    return 0 if report["machinePassed"] and report["acceptancePassed"] is not False else 1


if __name__ == "__main__":
    raise SystemExit(main())
