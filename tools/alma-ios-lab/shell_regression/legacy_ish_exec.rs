use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use crate::mobile_exec_command::mobile_system_command;

static ISH_EXEC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

pub(crate) fn install() {
    ISH_EXEC_HOOK_INSTALLED.get_or_init(|| {
        codex_core::exec::set_ios_exec_hook(run_command);
        codex_core::exec::set_ios_streaming_exec_hook(run_command_streaming);
        crate::shell_preflight::install();
    });
}

pub(crate) fn run_command(
    argv: &[String],
    cwd: &Path,
    _env: &HashMap<String, String>,
    timeout_ms: Option<u64>,
) -> (i32, Vec<u8>) {
    let started = Instant::now();
    // Run apply_patch in-process since iSH cannot exec the app binary.
    if argv
        .iter()
        .any(|arg| arg == codex_apply_patch::CODEX_CORE_APPLY_PATCH_ARG1)
    {
        let patch_arg = argv
            .iter()
            .skip_while(|arg| *arg != codex_apply_patch::CODEX_CORE_APPLY_PATCH_ARG1)
            .nth(1);
        if let Some(patch) = patch_arg {
            eprintln!("[ish-exec] apply_patch in-process patch_bytes={}", patch.len());
            let cwd_abs = match codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(cwd)
            {
                Ok(abs) => abs,
                Err(err) => {
                    let msg = format!("invalid cwd for apply_patch: {err}\n");
                    eprintln!("[ish-exec] apply_patch error_kind=invalid_cwd");
                    return (1, msg.into_bytes());
                }
            };
            let mut stdout_buf = Vec::new();
            let mut stderr_buf = Vec::new();
            let fs = codex_exec_server::LOCAL_FS.clone();
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    let msg = format!("build tokio runtime for apply_patch: {err}\n");
                    eprintln!("[ish-exec] apply_patch error_kind=runtime_setup");
                    return (1, msg.into_bytes());
                }
            };
            let result = runtime.block_on(codex_apply_patch::apply_patch(
                patch,
                &cwd_abs.into(),
                &mut stdout_buf,
                &mut stderr_buf,
                fs.as_ref(),
                None,
            ));
            let code = match result {
                Ok(_) => 0,
                Err(err) => {
                    // Patch errors can quote source lines or paths. Return the
                    // diagnostic to the caller, but keep it out of normal logs.
                    eprintln!("[ish-exec] apply_patch error_kind=apply_failed");
                    if stderr_buf.is_empty() {
                        stderr_buf = format!("{err}\n").into_bytes();
                    }
                    1
                }
            };
            let mut output = stdout_buf;
            output.extend_from_slice(&stderr_buf);
            eprintln!(
                "[ish-exec] apply_patch exit={code} output_len={} elapsed_ms={}",
                output.len(),
                started.elapsed().as_millis()
            );
            return (code, output);
        }
    }

    let cmd = mobile_system_command(argv);
    eprintln!(
        "[ish-exec] run argc={} command_bytes={} timeout_ms={timeout_ms:?}",
        argv.len(),
        cmd.len()
    );

    let cwd_str = cwd.to_string_lossy();
    let (code, output) = crate::ish_runtime::run(&cmd, Some(cwd_str.as_ref()), timeout_ms);

    eprintln!(
        "[ish-exec] exit={code} output_len={} elapsed_ms={}",
        output.len(),
        started.elapsed().as_millis()
    );

    (code, output)
}

pub(crate) fn run_command_streaming(
    argv: &[String],
    cwd: &Path,
    _env: &HashMap<String, String>,
    timeout_ms: Option<u64>,
    on_output: codex_core::exec::IosExecOutputHandler,
) -> (i32, Vec<u8>) {
    let started = Instant::now();
    // Run apply_patch in-process since iSH cannot exec the app binary.
    if argv
        .iter()
        .any(|arg| arg == codex_apply_patch::CODEX_CORE_APPLY_PATCH_ARG1)
    {
        let (code, output) = run_command(argv, cwd, _env, timeout_ms);
        if !output.is_empty() {
            on_output(output.clone());
        }
        return (code, output);
    }

    let cmd = mobile_system_command(argv);
    eprintln!(
        "[ish-exec] run(streaming) argc={} command_bytes={} timeout_ms={timeout_ms:?}",
        argv.len(),
        cmd.len()
    );

    let cwd_str = cwd.to_string_lossy();
    let (code, output) =
        crate::ish_runtime::run_streaming(&cmd, Some(cwd_str.as_ref()), timeout_ms, |chunk| {
            if !chunk.is_empty() {
                on_output(chunk.to_vec());
            }
        });

    eprintln!(
        "[ish-exec] exit(streaming)={code} output_len={} elapsed_ms={}",
        output.len(),
        started.elapsed().as_millis()
    );

    (code, output)
}
