use base64::Engine;
use ish_embed_host::{IshInstance, SpawnOpts, Stream, WorkspaceNetworkPolicy, WriteStatus};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::{Duration, Instant}};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let started = Instant::now();
    let instance = IshInstance::boot_workspace_policy_with_workspace(
        Path::new(&args[1]), None, Path::new(&args[2]))?;
    eprintln!("PROBE booted {:?}", started.elapsed());
    let view = "/workspace/attempts/probe/view";
    let scratch = "/workspace/attempts/probe/scratch";
    let reads: Vec<PathBuf> = ["/bin", "/sbin", "/usr", "/lib", "/etc", "/workspace/.runtime/kimi", view]
        .iter().map(PathBuf::from).collect();
    let mut writes = vec![PathBuf::from(scratch)];
    if args[3].contains("actor") { writes.push(PathBuf::from(format!("{view}/outbox"))); }
    let grant = instance.prepare_workspace_grant(&reads, &writes, WorkspaceNetworkPolicy::DenyDirect)?;
    let mut argv = vec!["/usr/bin/node".to_string()];
    if args[3] == "jitless" { argv.push("--jitless".into()); }
    if args[3].starts_with("diagnostic") {
        argv.extend(["--input-type=commonjs".into(), "-e".into(), std::fs::read_to_string(&args[4])?]);
    } else { argv.push("/workspace/.runtime/kimi/guest.mjs".into()); }
    let mut opts = SpawnOpts::cmd(argv);
    opts.cwd = Some(PathBuf::from(view));
    opts.pipe_stdin = true;
    opts.envp = Some([
        ("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("HOME", format!("{scratch}/home")), ("TMPDIR", scratch.into()),
        ("LANG", "C.UTF-8".into()), ("LC_ALL", "C.UTF-8".into()),
        ("SHELL", "/bin/bash".into()), ("BASH_ENV", "/dev/null".into()),
        ("ENV", "/dev/null".into()), ("KIMI_CODE_HOME", format!("{scratch}/home")),
        ("ALMA_KIMI_FETCH_BINDINGS", "node-fetch".into()),
    ].into_iter().map(|(k,v)| (k.into(),v)).collect());
    if args[3].contains("icu") {
        opts.envp.as_mut().unwrap().push(("ICU_DATA".into(), "/usr/share/icu/74.2".into()));
    }
    if args[3].contains("c-locale") {
        for (key, value) in opts.envp.as_mut().unwrap() {
            if key == "LANG" || key == "LC_ALL" { *value = "C".into(); }
        }
    }
    let session = instance.spawn_with_grant(opts, &grant)?;
    let initial = std::fs::read(&args[4])?;
    let fixture_plan: Value = serde_json::from_slice(&std::fs::read(&args[5])?)?;
    let mut sent = args[3].starts_with("diagnostic");
    let mut seq = 0;
    let mut pending = Vec::new();
    let mut http_requests = 0;
    let mut terminal: Option<Value> = None;
    loop {
        if started.elapsed() > Duration::from_secs(100) {
            eprintln!("PROBE deadline {:?}", session.status());
            session.terminate_owned(Duration::from_secs(5)).await?;
            break;
        }
        if !sent {
            match session.write(&initial).await? {
                WriteStatus::Accepted => { sent = true; eprintln!("PROBE start accepted {:?}", started.elapsed()); },
                WriteStatus::Starting => {},
                other => { eprintln!("PROBE stdin {other:?}"); sent = true; },
            }
        }
        let output = session.read(Some(seq), Some(1024*1024), Some(100)).await?;
        for chunk in output.chunks {
            seq = chunk.seq;
            let bytes = &chunk.bytes;
            match chunk.stream {
                Stream::Stderr => eprint!("{}", String::from_utf8_lossy(bytes)),
                _ => {
                    print!("{}", String::from_utf8_lossy(bytes));
                    pending.extend_from_slice(bytes);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        if let Some(payload) = line.strip_prefix(b"__ALMA_KIMI__") {
                            let frame: Value = serde_json::from_slice(payload)?;
                            if frame["kind"] == "http" {
                                http_requests += 1;
                                if args[3].contains("success") {
                                    let step = fixture_plan["steps"].get(http_requests - 1);
                                    let (delta, finish) = match step {
                                        Some(step) => (json!({"role":"assistant", "tool_calls":[{
                                            "index":0, "id":format!("tool-{http_requests}"), "type":"function",
                                            "function":{"name":step["name"], "arguments":step["arguments"].to_string()}
                                        }]}), "tool_calls"),
                                        None => (json!({"role":"assistant", "content":fixture_plan["finalText"]}), "stop"),
                                    };
                                    let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                                        json!({"id":format!("owned-fixture-{http_requests}"), "object":"chat.completion.chunk", "created":1,
                                            "model":"kimi-for-coding", "choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                                        json!({"id":format!("owned-fixture-{http_requests}"), "object":"chat.completion.chunk", "created":1,
                                            "model":"kimi-for-coding", "choices":[{"index":0,"delta":{},"finish_reason":finish}]}));
                                    let headers = json!({"kind":"headers","id":frame["id"],"status":200,"headers":{"content-type":"text/event-stream"}});
                                    let chunk = json!({"kind":"chunk","id":frame["id"],"data":base64::engine::general_purpose::STANDARD.encode(body)});
                                    session.write(format!("{headers}\n{chunk}\n").as_bytes()).await?;
                                } else {
                                    session.write(b"{\"kind\":\"cancel\"}\n").await?;
                                }
                            }
                            if frame["kind"] == "httpAck" && args[3].contains("success") {
                                let end = json!({"kind":"end","id":frame["id"]});
                                session.write(format!("{end}\n").as_bytes()).await?;
                            }
                            if frame["kind"] == "terminal" { terminal = Some(frame["terminal"].clone()); }
                        }
                    }
                },
            }
        }
        if output.closed { break; }
    }
    let status = session.status();
    eprintln!("PROBE_RESULT {}", json!({"mode":args[3],"seconds":started.elapsed().as_secs_f64(),
        "status":format!("{:?}",status),"exitCode":status.exit_code,"signal":status.term_signal,
        "closed":status.closed,"failure":status.failure,"httpRequests":http_requests,"terminal":terminal}));
    drop(session);
    drop(grant);
    tokio::time::timeout(Duration::from_secs(5), instance.shutdown()).await??;
    Ok(())
}
