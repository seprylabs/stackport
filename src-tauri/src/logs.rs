//! Log viewer: shows the end of a log file on the server and follows it live.
//!
//! `read` returns the last lines once (`tail -n`). `follow` keeps `tail -F` running over
//! ssh and sends new lines in batches as the event `log-lines` until `stop` is called
//! or the view closes. `count` counts errors and warnings in whole files for the
//! indicator, and `clear` empties a file; that is the only write to the server.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::models::{Project, Server};
use crate::ssh;

/// Upper limit for lines loaded at once
pub const MAX_LINES: u32 = 5000;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Lines sent to the UI in one event at most, so a noisy log doesn't flood it
const BATCH: usize = 500;

/// Running `tail -F` sessions: stream ID → stop signal
#[derive(Default)]
pub struct Following(Mutex<HashMap<String, oneshot::Sender<()>>>);

impl Following {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        self.0.lock().expect("log mutex poisoned")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinesEvent<'a> {
    stream_id: &'a str,
    lines: &'a [String],
    /// Last event of the stream
    ended: bool,
    /// Why following ended on its own (connection lost …); empty when stopped on purpose
    reason: Option<String>,
}

/// Remote command that runs `command` with the quoted file. Relative paths start in the project folder.
fn on_file(
    project_dir: Option<&str>,
    file: &str,
    command: impl FnOnce(&str) -> String,
) -> Result<String, String> {
    let file = file.trim();
    if file.is_empty() {
        return Err(tr!("No log file given.", "Keine Log-Datei angegeben."));
    }
    let command = command(&ssh::quote_path(file));
    if file.starts_with('/') || file.starts_with("~/") {
        return Ok(command);
    }
    let dir = project_dir
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| {
            tr!(
                "Relative log paths need the project's path on the server.",
                "Relative Log-Pfade brauchen den Pfad des Projekts auf dem Server."
            )
        })?;
    Ok(format!("cd {} && {command}", ssh::quote_path(dir)))
}

/// Remote command for `tail`
pub fn tail_command(
    project_dir: Option<&str>,
    file: &str,
    lines: u32,
    follow: bool,
) -> Result<String, String> {
    let lines = lines.min(MAX_LINES);
    let flag = if follow { " -F" } else { "" };
    on_file(project_dir, file, |f| {
        format!("tail -n {lines}{flag} -- {f}")
    })
}

// Entry lines as the viewer classifies them (src/lib/log-parse.ts), as POSIX extended regexes:
// Laravel/Monolog `[2026-11-10 09:12:01] production.ERROR: …` and
// PHP `[10-Nov-2026 09:12:01 UTC] PHP Fatal error: …`. Stack trace lines never match.
const ERRORS: &str = r"^\[[^]]*\][[:space:]]+[[:alnum:]_-]+\.(ERROR|CRITICAL|ALERT|EMERGENCY):|^(\[[^]]*\][[:space:]]+)?PHP (Fatal error|Parse error)";
const WARNINGS: &str = r"^\[[^]]*\][[:space:]]+[[:alnum:]_-]+\.(WARNING|NOTICE):|^(\[[^]]*\][[:space:]]+)?PHP (Warning|Notice|Deprecated)";

/// Prints "errors warnings" for the file, or "-" when it is missing or unreadable
fn count_command(project_dir: Option<&str>, file: &str) -> Result<String, String> {
    let count = on_file(project_dir, file, |f| {
        format!(
            "if [ -f {f} ] && [ -r {f} ]; then echo \"$(grep -cE -e '{ERRORS}' -- {f}) $(grep -cE -e '{WARNINGS}' -- {f})\"; else echo -; fi"
        )
    })?;
    Ok(format!("( {count} ) 2>/dev/null || echo -"))
}

/// Empties the file and prints "ok", or "missing" when there is no such file
fn clear_command(project_dir: Option<&str>, file: &str) -> Result<String, String> {
    on_file(project_dir, file, |f| {
        format!("if [ -f {f} ]; then : > {f} && echo ok; else echo missing; fi")
    })
}

/// Log files of a project: the saved ones, else the usual one for its stack (as in the UI)
pub fn paths(project: &Project) -> Vec<String> {
    let saved: Vec<String> = project
        .log_paths
        .as_deref()
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if !saved.is_empty() {
        return saved;
    }
    match project.stack.as_str() {
        "laravel" => vec!["storage/logs/laravel.log".into()],
        "wordpress" => vec!["wp-content/debug.log".into()],
        _ => Vec::new(),
    }
}

/// Errors and warnings in a whole log file
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCount {
    pub file: String,
    pub errors: u32,
    pub warnings: u32,
}

fn ssh_error(e: ssh::ConnectionResult) -> String {
    e.detail.unwrap_or_else(|| {
        tr!(
            "The SSH connection failed.",
            "Die SSH-Verbindung ist fehlgeschlagen."
        )
    })
}

/// Counts errors and warnings in all log files of the project with one ssh call.
/// Files that don't exist or can't be read are left out.
pub async fn count(project: &Project, server: &Server) -> Result<Vec<FileCount>, String> {
    let files: Vec<(String, String)> = paths(project)
        .into_iter()
        .filter_map(|f| Some((count_command(project_dir(project), &f).ok()?, f)))
        .collect();
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let script = files
        .iter()
        .map(|(cmd, _)| cmd.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    let script = format!("sh -c {}", ssh::shell_quote(&script));
    let out = ssh::run(server, &script, READ_TIMEOUT)
        .await
        .map_err(ssh_error)?;
    Ok(files
        .into_iter()
        .zip(out.lines())
        .filter_map(|((_, file), line)| {
            let (errors, warnings) = line.trim().split_once(' ')?;
            Some(FileCount {
                file,
                errors: errors.parse().ok()?,
                warnings: warnings.parse().ok()?,
            })
        })
        .collect())
}

/// Empties a log file on the server
pub async fn clear(project: &Project, server: &Server, file: &str) -> Result<(), String> {
    let cmd = format!("{} 2>&1", clear_command(project_dir(project), file)?);
    let cmd = format!("sh -c {}", ssh::shell_quote(&cmd));
    let out = ssh::run(server, &cmd, READ_TIMEOUT)
        .await
        .map_err(ssh_error)?;
    match out.trim() {
        "ok" => Ok(()),
        "missing" => Err(tr!(
            "The log file does not exist.",
            "Die Log-Datei existiert nicht."
        )),
        other => Err(other.to_string()),
    }
}

fn project_dir(project: &Project) -> Option<&str> {
    project.path.as_deref()
}

/// Last lines of a log file
pub async fn read(
    project: &Project,
    server: &Server,
    file: &str,
    lines: u32,
) -> Result<String, String> {
    let cmd = tail_command(project_dir(project), file, lines.max(1), false)?;
    // tail's own errors (file missing, no permission) go to stderr with a non-zero code
    let cmd = format!("{cmd} 2>&1");
    ssh::run(server, &cmd, READ_TIMEOUT)
        .await
        .map_err(ssh_error)
}

/// Starts following a log file; new lines arrive as `log-lines` events with `stream_id`
pub fn follow(
    app: &AppHandle,
    project: &Project,
    server: &Server,
    file: &str,
    stream_id: String,
) -> Result<(), String> {
    let cmd = tail_command(project_dir(project), file, 0, true)?;
    ssh::validate(server)?;
    let mut args = ssh::ssh_args(server);
    args.push(cmd);

    let (stop_tx, mut stop_rx) = oneshot::channel();
    app.state::<Following>()
        .lock()
        .insert(stream_id.clone(), stop_tx);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |lines: &[String], ended: bool, reason: Option<String>| {
            let _ = app.emit(
                "log-lines",
                LinesEvent {
                    stream_id: &stream_id,
                    lines,
                    ended,
                    reason,
                },
            );
        };
        let mut child = match Command::new("ssh")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                app.state::<Following>().lock().remove(&stream_id);
                emit(
                    &[],
                    true,
                    Some(tr!(
                        "Could not start ssh: {e}",
                        "ssh konnte nicht gestartet werden: {e}"
                    )),
                );
                return;
            }
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        if let Some(stdout) = child.stdout.take() {
            crate::deploy::forward(stdout, tx.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            crate::deploy::forward(stderr, tx);
        }

        let mut stopped = false;
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(line) => {
                        let mut batch = vec![line];
                        while batch.len() < BATCH {
                            match rx.try_recv() {
                                Ok(line) => batch.push(line),
                                Err(_) => break,
                            }
                        }
                        emit(&batch, false, None);
                    }
                    None => break,
                },
                _ = &mut stop_rx, if !stopped => {
                    stopped = true;
                    let _ = child.start_kill();
                }
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        app.state::<Following>().lock().remove(&stream_id);
        let reason = if stopped {
            None
        } else if code == Some(255) {
            Some(tr!(
                "The SSH connection was lost.",
                "Die SSH-Verbindung wurde getrennt."
            ))
        } else {
            Some(tr!("Following stopped.", "Mitlesen beendet."))
        };
        emit(&[], true, reason);
    });
    Ok(())
}

/// Stops following; false when the stream was not running
pub fn stop(app: &AppHandle, stream_id: &str) -> bool {
    match app.state::<Following>().lock().remove(stream_id) {
        Some(stop) => stop.send(()).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_start_in_project_folder() {
        let cmd = tail_command(
            Some("/var/www/shop"),
            "storage/logs/laravel.log",
            200,
            false,
        )
        .unwrap();
        assert_eq!(
            cmd,
            "cd '/var/www/shop' && tail -n 200 -- 'storage/logs/laravel.log'"
        );
    }

    #[test]
    fn absolute_and_home_paths_ignore_project_folder() {
        assert_eq!(
            tail_command(None, "/var/log/nginx/error.log", 50, true).unwrap(),
            "tail -n 50 -F -- '/var/log/nginx/error.log'"
        );
        assert_eq!(
            tail_command(Some("/srv"), "~/logs/php errors.log", 10, false).unwrap(),
            "tail -n 10 -- ~/'logs/php errors.log'"
        );
    }

    #[test]
    fn rejects_relative_path_without_project_folder_and_clamps_lines() {
        assert!(tail_command(None, "storage/logs/laravel.log", 10, false).is_err());
        assert!(tail_command(Some("/srv"), "  ", 10, false).is_err());
        assert!(
            tail_command(None, "/a.log", 999_999, false)
                .unwrap()
                .contains("-n 5000 ")
        );
    }

    fn sh(cmd: &str) -> String {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn counts_entries_in_a_real_shell_and_clears_the_file() {
        let dir = std::env::temp_dir().join("hostmoor-log-count-test");
        std::fs::create_dir_all(dir.join("storage/logs")).unwrap();
        let log = "\
[2026-11-10 09:12:01] production.ERROR: SQLSTATE[HY000] Connection refused {\"exception\":\"[object] (PDOException(code: 2002))
[stacktrace]
#0 /var/www/vendor/laravel/framework/src/Illuminate/Database/Connection.php(1): ERROR: not an entry
\"}
[2026-11-10 09:13:00] local.WARNING: Cache miss
[2026-11-10 09:14:00] production.INFO: User saw a production.ERROR: page
[2026-11-10T09:15:00.123456+01:00] production.CRITICAL: Queue down
[2026-11-10 09:16:00] production.NOTICE: Slow query
[10-Nov-2026 09:17:00 UTC] PHP Warning:  Undefined variable $x
[2026-11-10 09:18:00] production.DEBUG: PHP Fatal error mentioned in a message
";
        std::fs::write(dir.join("storage/logs/laravel.log"), log).unwrap();
        let file = "storage/logs/laravel.log";

        let count = count_command(dir.to_str(), file).unwrap();
        assert_eq!(sh(&count), "2 3\n");
        let missing = count_command(dir.to_str(), "storage/logs/nope.log").unwrap();
        assert_eq!(sh(&missing), "-\n");
        let bad_dir = count_command(Some("/does/not/exist"), file).unwrap();
        assert_eq!(sh(&bad_dir), "-\n");

        assert_eq!(sh(&clear_command(dir.to_str(), file).unwrap()), "ok\n");
        assert_eq!(std::fs::read(dir.join(file)).unwrap().len(), 0);
        assert_eq!(sh(&count), "0 0\n");
        assert_eq!(
            sh(&clear_command(dir.to_str(), "storage/logs/nope.log").unwrap()),
            "missing\n"
        );
        assert!(!dir.join("storage/logs/nope.log").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn paths_fall_back_to_the_stack_default() {
        let mut project: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "Shop", "customerId": "c", "stack": "laravel"
        }))
        .unwrap();
        assert_eq!(paths(&project), ["storage/logs/laravel.log"]);
        project.log_paths = Some(" a.log \n\n/var/log/b.log\n".into());
        assert_eq!(paths(&project), ["a.log", "/var/log/b.log"]);
        project.stack = "static".into();
        project.log_paths = None;
        assert!(paths(&project).is_empty());
    }

    #[test]
    fn quoting_survives_a_real_shell() {
        // A hostile file name must stay one argument and not run anything
        let dir = std::env::temp_dir().join("hostmoor-log-test");
        std::fs::create_dir_all(&dir).unwrap();
        let name = "a'; touch pwned; '.log";
        std::fs::write(dir.join(name), "one\ntwo\nthree\n").unwrap();
        let cmd = tail_command(dir.to_str(), name, 2, false).unwrap();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "two\nthree\n");
        assert!(!dir.join("pwned").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
