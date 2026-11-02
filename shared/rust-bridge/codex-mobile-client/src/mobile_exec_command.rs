#[cfg(target_os = "android")]
use codex_shell_command::parse_command::extract_shell_command;
use codex_shell_command::parse_command::shlex_join;

#[cfg(target_os = "android")]
use crate::shell_quoting::posix_quote;

/// Build the single command string that gets handed to the iOS iSH shell
/// (or the Android equivalent). Quote each argument independently so iSH's
/// outer sh transports the argv without interpreting the inner script. This
/// preserves Bash, explicit sh, other interpreters, flags, and `$0`/`$@`.
/// A display parser's extracted script is too lossy for execution routing.
pub(crate) fn mobile_system_command(argv: &[String]) -> String {
    // Preserve Android's existing behavior; its runtime is outside this iSH fix.
    #[cfg(target_os = "android")]
    if let Some((_, script)) = extract_shell_command(argv) {
        return format!("sh -c {}", posix_quote(script));
    }
    shlex_join(argv)
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn preserves_zsh_wrapper_without_reinterpreting_its_script() {
        let argv = vec!["/bin/zsh".into(), "-lc".into(), "echo hello".into()];
        assert_eq!(mobile_system_command(&argv), "/bin/zsh -lc 'echo hello'");
    }

    #[test]
    fn wraps_script_with_semicolons() {
        let argv = vec!["sh".into(), "-c".into(), "echo one; echo two".into()];
        assert_eq!(mobile_system_command(&argv), "sh -c 'echo one; echo two'");
    }

    #[test]
    fn wraps_script_with_heredoc() {
        let script = "cat <<'EOF' > out.txt\nA\nB\nEOF";
        let argv = vec!["sh".into(), "-c".into(), script.into()];
        assert_eq!(shlex::split(&mobile_system_command(&argv)).unwrap(), argv);
    }

    #[test]
    fn escapes_single_quote_inside_script() {
        let argv = vec!["sh".into(), "-c".into(), "echo it's fine".into()];
        assert_eq!(shlex::split(&mobile_system_command(&argv)).unwrap(), argv);
    }

    #[test]
    fn shell_joins_plain_argv() {
        let argv = vec!["cat".into(), "file with spaces.js".into()];
        assert_eq!(mobile_system_command(&argv), "cat 'file with spaces.js'");
    }
}
