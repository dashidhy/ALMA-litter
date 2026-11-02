// The runner adds module paths. External integrations below are test doubles;
// the production preflight, serializer, and ish_exec functions are compiled.
extern crate self as codex_shell_command;
extern crate self as codex_core;
extern crate self as codex_apply_patch;
extern crate self as codex_utils_absolute_path;
extern crate self as codex_exec_server;
extern crate self as tokio;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub mod exec {
    use super::*;
    pub type IosExecOutputHandler = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
    pub fn set_mobile_exec_preflight(_: fn(&mut Vec<String>)) {}
    pub fn set_ios_exec_hook(_: fn(&[String], &Path, &HashMap<String, String>, Option<u64>) -> (i32, Vec<u8>)) {}
    pub fn set_ios_streaming_exec_hook(_: fn(&[String], &Path, &HashMap<String, String>, Option<u64>, IosExecOutputHandler) -> (i32, Vec<u8>)) {}
}

pub const CODEX_CORE_APPLY_PATCH_ARG1: &str = "--codex-run-as-apply-patch";
pub struct AbsolutePathBuf(PathBuf);
impl AbsolutePathBuf {
    pub fn from_absolute_path(path: &Path) -> Result<Self, &'static str> {
        if !path.is_absolute() { return Err("PRIVATE_CWD_ERROR"); }
        Ok(Self(path.into()))
    }
}
impl From<AbsolutePathBuf> for PathBuf {
    fn from(value: AbsolutePathBuf) -> Self { value.0 }
}
#[derive(Clone)]
pub struct FakeFs;
pub static LOCAL_FS: FakeFs = FakeFs;
impl AsRef<FakeFs> for FakeFs { fn as_ref(&self) -> &Self { self } }
pub async fn apply_patch(_: &str, _: &PathBuf, _: &mut Vec<u8>, _: &mut Vec<u8>, _: &FakeFs, _: Option<()>) -> Result<(), &'static str> {
    Err("PRIVATE_PATCH_ERROR: 秘密 🔐")
}
static FAIL_RUNTIME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub mod runtime {
    pub struct Builder;
    pub struct Runtime;
    impl Builder {
        pub fn new_current_thread() -> Self { Self }
        pub fn enable_all(self) -> Self { self }
        pub fn build(self) -> Result<Runtime, &'static str> {
            if super::FAIL_RUNTIME.load(std::sync::atomic::Ordering::SeqCst) {
                Err("PRIVATE_RUNTIME_ERROR")
            } else { Ok(Runtime) }
        }
    }
    impl Runtime {
        pub fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
            let mut future = std::pin::pin!(future);
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            match future.as_mut().poll(&mut context) {
                std::task::Poll::Ready(value) => value,
                _ => panic!("test double must complete immediately"),
            }
        }
    }
}

// This deliberately does not simulate iSH. Most tests use host /bin/sh as the
// transport into the requested real host interpreter. Logging tests inject
// exact output bytes and status at the runtime boundary.
static RUNTIME_OUTPUT: Mutex<Option<(i32, Vec<u8>)>> = Mutex::new(None);
pub mod ish_runtime {
    use super::*;
    pub fn run(cmd: &str, cwd: Option<&str>, timeout: Option<u64>) -> (i32, Vec<u8>) {
        run_streaming(cmd, cwd, timeout, |_| {})
    }
    pub fn run_streaming<F: FnMut(&[u8])>(cmd: &str, cwd: Option<&str>, _: Option<u64>, mut on_output: F) -> (i32, Vec<u8>) {
        let result = if let Some(result) = RUNTIME_OUTPUT.lock().unwrap().clone() {
            result
        } else {
            let mut process = std::process::Command::new("/bin/sh");
            process.args(["-c", cmd]);
            if let Some(cwd) = cwd { process.current_dir(cwd); }
            let output = process.output().expect("host transport");
            let mut bytes = output.stdout;
            bytes.extend_from_slice(&output.stderr);
            (output.status.code().unwrap_or(-1), bytes)
        };
        for chunk in result.1.chunks(7) { on_output(chunk); }
        result
    }
}

fn argv(parts: &[&str]) -> Vec<String> { parts.iter().map(|part| (*part).into()).collect() }

#[cfg(not(alma_android))]
mod ios_tests {
    use super::*;
    fn execute(parts: &[&str]) -> (i32, Vec<u8>) {
        let mut args = argv(parts);
        shell_preflight::prepare_mobile_exec_argv(&mut args);
        ish_exec::run_command(&args, Path::new("/"), &HashMap::new(), Some(5000))
    }
    fn output(parts: &[&str], expected: &str) {
        let (code, bytes) = execute(parts);
        assert_eq!(code, 0, "{}", String::from_utf8_lossy(&bytes));
        assert_eq!(bytes, expected.as_bytes());
    }

    #[test]
    fn upstream_bash_exec_args_reach_bash_for_both_login_modes() {
        let shell = parse_command::Shell { shell_type: parse_command::ShellType::Bash, shell_path: "/bin/bash".into() };
        for login in [false, true] {
            let script = "a=(zero '中文 🔐'); [[ -n $BASH_VERSION ]] && printf '%s' \"${a[1]}\"";
            let mut args = shell.derive_exec_args(script, login);
            let expected = args.clone();
            shell_preflight::prepare_mobile_exec_argv(&mut args);
            assert_eq!(args, expected);
            let (code, bytes) = ish_exec::run_command(&args, Path::new("/"), &HashMap::new(), None);
            assert_eq!(code, 0);
            assert_eq!(bytes, "中文 🔐".as_bytes());
        }
    }

    #[test]
    fn interpreter_matrix_round_trips_every_argument() {
        for parts in [
            vec!["/bin/bash", "-lc", "a=(x); printf '%s' \"${a[0]}\""],
            vec!["bash", "--noprofile", "--norc", "-c", "printf '%s' \"$@\"", "label", "", "a b", "it's", "$x;$(false)"],
            vec!["/bin/sh", "-c", "printf '%s' \"$0:$1\"", "internal", "value"],
            vec!["/bin/zsh", "-lc", "print -r -- ${(U)ZSH_VERSION}"],
            vec!["pwsh", "-NoProfile", "-Command", "Write-Output '秘密'"],
            vec!["python3", "-c", "print('秘密')"],
            vec!["node", "-e", "console.log('秘密')"],
            vec!["/opt/missing-interpreter", "-c", "echo no fallback"],
            vec!["cat", "", "a b", "line\nbreak", "'\"$;`"],
            vec![],
        ] {
            let original = argv(&parts);
            let mut args = original.clone();
            shell_preflight::prepare_mobile_exec_argv(&mut args);
            assert_eq!(args, original);
            assert_eq!(shlex::split(&mobile_exec_command::mobile_system_command(&args)).unwrap(), original);
        }
    }

    #[test]
    fn bash_positional_arguments_empty_strings_and_metacharacters() {
        output(&["/bin/bash", "--noprofile", "--norc", "-c", "printf '<%s>' \"$0\" \"$@\"", "label", "", "a b", "it's", "$(printf INJECTED);*"],
               "<label><><a b><it's><$(printf INJECTED);*>");
    }

    #[test]
    fn heredoc_pipeline_quotes_and_unicode_are_not_parsed_by_outer_sh() {
        output(&["/bin/bash", "-c", "cat <<'EOF' | tr a-z A-Z\nit's $HOME `literal` $(literal); 中文 🔐\nEOF"],
               "IT'S $HOME `LITERAL` $(LITERAL); 中文 🔐\n");
    }

    #[test]
    fn explicit_internal_sh_remains_sh() {
        output(&["/bin/sh", "-c", "printf '%s' \"$0:$1\"", "internal-sh", "秘密"], "internal-sh:秘密");
    }

    #[test]
    fn zsh_specific_expansion_runs_in_zsh() {
        output(&["/bin/zsh", "-fc", "value=hello; print -rn -- ${(U)value}"], "HELLO");
    }

    #[test]
    fn bash_python_and_node_subprocesses_round_trip_a_unicode_file() {
        // The runner's cwd is this test's dedicated .build/version-platform
        // directory. This test never writes to the workspace or system /tmp.
        let script = r#"set -e
python3 -c 'from pathlib import Path; import subprocess; p=Path("中文 🔐 file.txt"); p.write_text("秘密 🔐", encoding="utf-8"); assert subprocess.check_output(["/bin/bash", "-c", "a=(zero one); printf %s ${a[1]}"]) == b"one"'
node -e 'const fs = require("fs"); const cp = require("child_process"); const body = fs.readFileSync("中文 🔐 file.txt", "utf8"); if (cp.execFileSync("/bin/bash", ["-c", "a=(one two); printf %s ${a[1]}"], {encoding:"utf8"}) !== "two") process.exit(9); process.stdout.write(body);'
"#;
        let mut args = argv(&["/bin/bash", "-c", script]);
        shell_preflight::prepare_mobile_exec_argv(&mut args);
        let (code, bytes) = ish_exec::run_command(&args, &std::env::current_dir().unwrap(), &HashMap::new(), None);
        assert_eq!(code, 0, "{}", String::from_utf8_lossy(&bytes));
        assert_eq!(bytes, "秘密 🔐".as_bytes());
    }

    #[test]
    fn missing_interpreter_reports_failure_instead_of_fallback() {
        let (code, bytes) = execute(&["/definitely-missing/PRIVATE_INTERPRETER", "-c", "printf PRIVATE_FALLBACK"]);
        assert_eq!(code, 127);
        assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE_FALLBACK"));
    }

    #[test]
    fn nonzero_exit_and_streamed_bytes_are_preserved() {
        let args = argv(&["/bin/bash", "-c", "a=('PRIVATE_STREAM 秘密 🔐'); [[ -n $BASH_VERSION ]] && printf '%s' \"${a[0]}\"; exit 23"]);
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let callback = chunks.clone();
        let (code, bytes) = ish_exec::run_command_streaming(&args, Path::new("/"), &HashMap::new(), None,
            Arc::new(move |chunk| callback.lock().unwrap().extend(chunk)));
        assert_eq!(code, 23);
        assert_eq!(bytes, "PRIVATE_STREAM 秘密 🔐".as_bytes());
        assert_eq!(*chunks.lock().unwrap(), bytes);
    }

    #[test]
    fn logging_handles_utf8_boundaries_invalid_utf8_and_large_output() {
        let mut cases = vec![vec![], vec![b'a'; 199], vec![b'a'; 200], vec![b'a'; 201], vec![0xff; 201], "秘密🔐".repeat(100_000).into_bytes()];
        for boundary in [198, 199, 200, 201] {
            for suffix in ["中PRIVATE_OUTPUT", "🔐PRIVATE_OUTPUT"] {
                let mut bytes = vec![b'a'; boundary];
                bytes.extend_from_slice(suffix.as_bytes());
                cases.push(bytes);
            }
        }
        for bytes in cases {
            *RUNTIME_OUTPUT.lock().unwrap() = Some((23, bytes.clone()));
            let args = argv(&["bash", "-c", "printf 'PRIVATE_COMMAND 秘密 🔐'"]);
            let cwd = Path::new("/PRIVATE_CWD/秘密🔐");
            assert_eq!(ish_exec::run_command(&args, cwd, &HashMap::new(), Some(5000)), (23, bytes.clone()));
            let chunks = Arc::new(Mutex::new(Vec::new()));
            let callback = chunks.clone();
            let result = ish_exec::run_command_streaming(&args, cwd, &HashMap::new(), Some(5000),
                Arc::new(move |chunk| callback.lock().unwrap().extend(chunk)));
            assert_eq!(result, (23, bytes.clone()));
            assert_eq!(*chunks.lock().unwrap(), bytes);
        }
        *RUNTIME_OUTPUT.lock().unwrap() = None;
    }

    #[test]
    fn patch_error_details_are_returned_without_logging_bodies() {
        let args = argv(&["app", CODEX_CORE_APPLY_PATCH_ARG1, "PRIVATE_PATCH_BODY 秘密 🔐"]);
        let (code, bytes) = ish_exec::run_command(&args, Path::new("/PRIVATE_CWD"), &HashMap::new(), None);
        assert_eq!(code, 1);
        assert!(String::from_utf8_lossy(&bytes).contains("PRIVATE_PATCH_ERROR"));
        let (_, bytes) = ish_exec::run_command(&args, Path::new("PRIVATE_RELATIVE_CWD"), &HashMap::new(), None);
        assert!(String::from_utf8_lossy(&bytes).contains("PRIVATE_CWD_ERROR"));
        FAIL_RUNTIME.store(true, std::sync::atomic::Ordering::SeqCst);
        let (_, bytes) = ish_exec::run_command(&args, Path::new("/"), &HashMap::new(), None);
        FAIL_RUNTIME.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(String::from_utf8_lossy(&bytes).contains("PRIVATE_RUNTIME_ERROR"));
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let callback = chunks.clone();
        let result = ish_exec::run_command_streaming(&args, Path::new("/"), &HashMap::new(), None,
            Arc::new(move |chunk| callback.lock().unwrap().extend(chunk)));
        assert_eq!(result.0, 1);
        assert_eq!(*chunks.lock().unwrap(), result.1);
    }
}

#[cfg(alma_android)]
mod android_tests {
    use super::*;
    #[test]
    fn original_android_normalization_and_tmp_policy_are_unchanged() {
        // Runner serializes all tests because production tmp tests change env.
        unsafe { std::env::set_var("TMPDIR", "/android/tmp"); }
        for shell in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
            let mut args = argv(&[shell, "-lc", "cat /tmp/hello"]);
            shell_preflight::prepare_mobile_exec_argv(&mut args);
            assert_eq!(args, argv(&["sh", "-c", "cat /android/tmp/hello"]));
            assert_eq!(mobile_exec_command::mobile_system_command(&args), "sh -c 'cat /android/tmp/hello'");
        }
        let mut args = argv(&["bash", "-c", "printf '%s' \"$1\"", "label", "value"]);
        let original = args.clone();
        shell_preflight::prepare_mobile_exec_argv(&mut args);
        assert_eq!(args, original);
        unsafe { std::env::remove_var("TMPDIR"); }
    }
    #[test]
    fn original_android_powershell_display_parser_behavior_is_unchanged() {
        let args = argv(&["pwsh", "-NoProfile", "-Command", "Write-Output hello"]);
        assert_eq!(mobile_exec_command::mobile_system_command(&args), "sh -c 'Write-Output hello'");
    }
}
