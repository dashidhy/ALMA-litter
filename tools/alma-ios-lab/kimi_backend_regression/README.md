# Kimi native backend resource limits and regression checks

## Owned process budgets

The Kimi guest scope explicitly configures `IshExecBackend` with a 16 MiB
cumulative stdin budget and a 16 MiB cumulative stdout/stderr retention budget.
The output configuration admits up to 16,384 retained chunks. This opt-in resolves
the earlier warning that Kimi attempts would hit the default 1 MiB output cap.

The Codex shell defaults are 1 MiB cumulative stdin, 1 MiB cumulative output,
and 4,096 retained output chunks. Each stdin write accepts at most 32 KiB.
KimiBackend splits larger JSON lines across writes and reassembles stdout lines
across process reads.

Both process byte budgets apply across the whole attempt. Stdin includes the
start envelope, HTTP response headers and base64-encoded response chunks.
Output includes protocol frames, repeated HTTP request bodies, normalized events,
terminal text and discarded guest log bytes. Consuming retained output does not
reset the process budget.

## Kimi transport bounds

| Resource | Limit |
| --- | --- |
| Protocol line | 2 MiB |
| HTTP request body | 1 MiB per request |
| HTTP response body | 2 MiB per request |
| Request and response headers | 64 headers and 16 KiB of names/values |
| Response chunk before base64 encoding | 8 KiB |
| Active HTTP requests | 4 |
| Total admitted HTTP requests | 128 per attempt |
| Retained normalized events | 256 events and 4 MiB |
| Attempt execution deadline | 30 minutes |
| HTTP request deadline, including consumer ACK waits | 120 seconds |
| Individual chunk ACK deadline | 30 seconds |
| Stdin frame write deadline | 10 seconds |
| Process termination and retained-output drain deadline | 20 seconds |

JSON escaping and base64 expansion count toward their enclosing transport
budgets. The 2 MiB frame bound fits inside the Kimi process retention budget.
Each remaining limit is enforced independently, so a long attempt can exhaust
request count, retained events, transport bytes or time before another limit.
Transport or retention overflow produces an explicit failure. Capture and release
require confirmed process closure and successful scope finish.

These bounds describe the implemented execution envelope. NVIDIA/TAH qualification
results apply to the specific inputs and runtime versions recorded for each run.

## Regression coverage

Run `python3 tools/alma-ios-lab/kimi_backend_regression/run.py` from the repository
root. The 23 host checks compile production KimiBackend and IshExecBackend with
explicit iSH session, scope and protocol DTO doubles. The ExecProcess producer and
traits are extracted from pinned upstream source. Loopback HTTP exercises the
response pump, chunk ACK pacing and cancellation. Web request fixtures are pinned
to Kimi Code 2.4.1 / SDK 0.22.0 and carry source hashes.

The owned-process cases cover a start envelope above 1 MiB, cumulative output above
3 MiB, a single escaped terminal line around 1.8 MiB, rejection above the 2 MiB
frame bound, exact 16 MiB process byte ceilings and the default shell ceilings.
They assert scope finish follows confirmed process closure.

Normal guest terminal delivery follows awaited SDK session/harness closure and
private-home cleanup. The Rust backend then joins HTTP tasks, terminates and drains
the owned process, finishes the scope, and exposes `{done:true,terminal}` after
the retained events.

`run.py --ios` performs a standalone metadata check against the successful mobile
build's cached dependency graph. The parent integration lane owns full application
builds and kernel/device qualification. Detailed host and metadata logs are stored
under this helper's ignored `.cache` directory.
