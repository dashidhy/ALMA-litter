use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use crate::tah_attempt;

type Result<T=()> = std::result::Result<T,String>;
fn sha(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn fixture(name:&str)->Value {
    serde_json::from_slice(&std::fs::read(Path::new(&std::env::var("TAH_FIXTURES").unwrap()).join(format!("{name}.json"))).unwrap()).unwrap()
}
fn area(label:&str)->PathBuf {
    let root=Path::new(&std::env::var("TAH_WORKSPACES").unwrap()).join(format!("{label}-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();root
}
fn write_envelope(root:&Path, value:&Value) {
    std::fs::create_dir_all(root.join("documents")).unwrap();
    std::fs::write(root.join("documents/inbound-attempt.json"),serde_json::to_vec(value).unwrap()).unwrap();
}
fn prepare(root:&Path,value:&Value)->Result<tah_attempt::PreparedAttempt> {
    write_envelope(root,value);
    tah_attempt::prepare(&root.join("documents"),&root.join("workspace"))
        .map_err(|e|format!("{:?}: {e}",e.kind()))
}
fn ensure(condition:bool,message:&str)->Result {if condition {Ok(())} else {Err(message.into())}}
fn actual_files(root:&Path)->BTreeMap<String,Vec<u8>> {
    fn walk(root:&Path,dir:&Path,out:&mut BTreeMap<String,Vec<u8>>) {
        for item in std::fs::read_dir(dir).unwrap() {
            let path=item.unwrap().path();
            if path.is_dir(){walk(root,&path,out)}else{out.insert(path.strip_prefix(root).unwrap().to_string_lossy().into(),std::fs::read(path).unwrap());}
        }
    }
    let mut result=BTreeMap::new();walk(root,root,&mut result);result
}
fn exact_import(name:&str)->Result {
    let env=fixture(name);let root=area(name);let p=prepare(&root,&env)?;
    let original:Value=serde_json::from_str(env["attemptJSON"].as_str().unwrap()).unwrap();
    let expected:BTreeMap<_,_>=env["inputFiles"].as_array().unwrap().iter().map(|f|(
        f["relativePath"].as_str().unwrap().to_owned(),
        base64::engine::general_purpose::STANDARD.decode(f["base64"].as_str().unwrap()).unwrap())).collect();
    ensure(actual_files(&p.view)==expected,"material bytes/path inventory differs")?;
    ensure(p.info.attempt_id==original["attemptID"].as_str().unwrap(),"attempt ID differs")?;
    ensure(p.info.model==original["inference"]["modelID"].as_str().unwrap(),"model differs")?;
    ensure(p.info.developer_instructions==env["developerInstructions"].as_str().unwrap(),"instruction bytes differ")?;
    ensure(p.info.turn_input_text==env["turnInputText"].as_str().unwrap(),"reference channel bytes differ")?;
    ensure(p.info.attempt_sha256==env["attemptSHA256"].as_str().unwrap(),"attempt digest differs")?;
    let writes:Vec<String>=serde_json::from_value(original["workspace"]["writableRoots"].clone()).unwrap();
    ensure(p.writable_roots==writes,"writable roots differ")?;
    ensure(p.scratch.join("home").is_dir(),"scratch home absent")?;
    ensure(p.immutable_inputs.len()==expected.len(),"immutable map differs")?;
    for (name,bytes) in expected {ensure(p.immutable_inputs.get(&name)==Some(&sha(&bytes)),"immutable material hash differs")?;}
    Ok(())
}
fn mutate_attempt(env:&mut Value, update:impl FnOnce(&mut Value)) {
    let mut attempt:Value=serde_json::from_str(env["attemptJSON"].as_str().unwrap()).unwrap();
    update(&mut attempt);let text=serde_json::to_string(&attempt).unwrap();
    env["attemptSHA256"]=json!(sha(text.as_bytes()));env["attemptJSON"]=json!(text);
}
fn rejected_without_workspace(value:&Value,label:&str)->Result {
    let root=area(label);write_envelope(&root,value);
    let before=std::fs::read(root.join("documents/inbound-attempt.json")).unwrap();
    ensure(tah_attempt::prepare(&root.join("documents"),&root.join("workspace")).is_err(),"invalid envelope accepted")?;
    ensure(!root.join("workspace").exists(),"rejected manifest created workspace/output")?;
    ensure(std::fs::read(root.join("documents/inbound-attempt.json")).unwrap()==before,"inbound manifest modified")
}

#[test]
fn original_ts_to_actual_rust_differential() {
    let mut cases=Vec::new();
    let raw=exact_import("raw");let actor=exact_import("actor");
    cases.push(json!({"name":"valid_raw_exact_import","status":if raw.is_ok(){"passed"}else{"failed"},"error":raw.as_ref().err()}));
    cases.push(json!({"name":"valid_actor_exact_import","status":if actor.is_ok(){"passed"}else{"failed"},"error":actor.as_ref().err()}));
    let valid=raw.is_ok() && actor.is_ok();
    let mut case=|name:&str,requires_valid:bool,test: &dyn Fn()->Result| {
        if requires_valid && !valid {cases.push(json!({"name":name,"status":"blocked","reason":"original valid-envelope prerequisite rejected; negative rejection would not exercise its intended boundary"}));return;}
        let outcome=test();cases.push(json!({"name":name,"status":if outcome.is_ok(){"passed"}else{"failed"},"error":outcome.err()}));
    };
    case("wrong_attempt_and_material_hash",true,&|| {
        let mut e=fixture("raw");e["attemptSHA256"]=json!("0".repeat(64));rejected_without_workspace(&e,"attempt-hash")?;
        let mut e=fixture("raw");mutate_attempt(&mut e,|a|a["workspace"]["materials"][0]["sha256"]=json!("0".repeat(64)));
        rejected_without_workspace(&e,"material-hash")
    });
    case("extra_missing_duplicate_files",true,&|| {
        let mut e=fixture("actor");e["inputFiles"].as_array_mut().unwrap().push(json!({"relativePath":"extra.txt","base64":"eA=="}));rejected_without_workspace(&e,"extra")?;
        let mut e=fixture("actor");e["inputFiles"].as_array_mut().unwrap().pop();rejected_without_workspace(&e,"missing")?;
        let mut e=fixture("actor");e["inputFiles"][1]=e["inputFiles"][0].clone();rejected_without_workspace(&e,"duplicate")
    });
    case("escaped_path_and_noncanonical_write_root",true,&|| {
        let mut e=fixture("actor");let previous:Value=serde_json::from_str(e["attemptJSON"].as_str().unwrap()).unwrap();
        let name=previous["workspace"]["materials"][0]["relativePath"].as_str().unwrap();
        for f in e["inputFiles"].as_array_mut().unwrap(){if f["relativePath"]==name {f["relativePath"]=json!("../owned-invalid.txt");}}
        mutate_attempt(&mut e,|a|a["workspace"]["materials"][0]["relativePath"]=json!("../owned-invalid.txt"));
        rejected_without_workspace(&e,"lexical-traversal")?;
        let mut e=fixture("actor");mutate_attempt(&mut e,|a|a["workspace"]["writableRoots"][0]=json!("outbox/revision_v00"));
        rejected_without_workspace(&e,"noncanonical-root")
    });
    case("reused_attempt_id_preserves_first_view",true,&|| {
        let e=fixture("actor");let root=area("reused");let p=prepare(&root,&e)?;
        let before=actual_files(&p.view);ensure(prepare(&root,&e).is_err(),"attempt ID was reused")?;
        ensure(actual_files(&p.view)==before,"rejected replay changed first view")
    });
    case("malformed_manifest_no_output_io",false,&|| {
        let root=area("bad-json");std::fs::create_dir_all(root.join("documents")).unwrap();
        std::fs::write(root.join("documents/inbound-attempt.json"),b"{not valid JSON").unwrap();
        ensure(tah_attempt::prepare(&root.join("documents"),&root.join("workspace")).is_err(),"malformed JSON accepted")?;
        ensure(!root.join("workspace").exists(),"bad JSON created output workspace")
    });
    case("prompt_channel_mismatch",true,&|| {
        let mut e=fixture("raw");e["developerInstructions"]=json!(format!("{}\nchanged",e["developerInstructions"].as_str().unwrap()));
        rejected_without_workspace(&e,"instructions")?;
        let mut e=fixture("raw");e["turnInputText"]=json!("{\"schema\":\"alma.tah.prompt-envelope/v1\",\"blocks\":[]}");
        rejected_without_workspace(&e,"reference")
    });
    // Diagnostic only: change ID property spellings, never a valid Mac fixture.
    // This distinguishes parser spelling failures from materialization failures.
    let diagnostic=if !valid {
        let mut e=fixture("raw");mutate_attempt(&mut e,|a| {
            for (from,to) in [("attemptID","attemptId"),("providerID","providerId")] {
                if let Some(v)=a.as_object_mut().unwrap().remove(from){a[to]=v;}
            }
            for (from,to) in [("modelID","modelId"),("reasoningEffortID","reasoningEffortId")] {
                if let Some(v)=a["inference"].as_object_mut().unwrap().remove(from){a["inference"][to]=v;}
            }
        });
        let result=prepare(&area("noncanonical-id-diagnostic"),&e);
        json!({"scope":"noncanonical diagnostic only; NOT original Mac contract acceptance", "normalized_id_spelling_accepted":result.is_ok(),"error":result.err()})
    }else{Value::Null};
    let success=cases.iter().all(|c|c["status"]=="passed");
    let report=json!({"passed":success,"cases":cases,"diagnostic":diagnostic,
        "scope":"Actual unchanged Rust prepare and ScopedFiles modules; original TS builder/projector bytes; no phone/model/auth/network", "capture_candidates_exercised":false,
        "no_io_definition":"Rejected input creates no workspace/output tree; reading the inbound manifest is required and not forbidden"});
    std::fs::write(std::env::var("TAH_CASE_REPORT").unwrap(),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(success,"original TS -> Rust differential failed; see cases.json; blocked negatives are not passes");
}
