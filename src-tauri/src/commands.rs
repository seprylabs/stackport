use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::check::{self, CheckError};
use crate::ci::{self, CiResult};
use crate::ci_watch::{CiWatch, ProjectCi};
use crate::db::{Db, Table};
use crate::deploy;
use crate::log_watch::{self, LogStatus, LogWatch};
use crate::logs;
use crate::models::{Backup, Customer, Deploy, LastDeploy, Project, Server, Snapshot};
use crate::site_watch::{self, SiteStatus, SiteWatch};
use crate::ssh::{self, ConnectionResult};
use crate::ssh_config::{self, ConfigHost};
use crate::terminal;

type CmdResult<T> = Result<T, String>;

const BACKUP_APP: &str = "Hostmoor";
/// Backups written before the rename to Hostmoor
const LEGACY_BACKUP_APP: &str = "StackPort";
const BACKUP_FORMAT_VERSION: u32 = 1;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn load_all(db: State<Db>) -> CmdResult<Snapshot> {
    db.snapshot().map_err(err)
}

#[tauri::command]
pub fn save_customer(db: State<Db>, customer: Customer) -> CmdResult<()> {
    db.save_customer(&customer).map_err(err)
}

#[tauri::command]
pub fn save_server(db: State<Db>, server: Server) -> CmdResult<()> {
    db.save_server(&server).map_err(err)
}

/// Hosts from ~/.ssh/config for the import; only reads the file.
/// Hosts that Hostmoor could not connect to safely (odd characters) are left out.
#[tauri::command]
pub fn read_ssh_config() -> Vec<ConfigHost> {
    ssh_config::read_default()
        .into_iter()
        .filter(|h| {
            ssh::validate(&Server {
                id: String::new(),
                name: h.alias.clone(),
                provider: "other".into(),
                host: h.host.clone(),
                port: h.port,
                ssh_user: h.user.clone(),
                ssh_key_path: h.identity_file.clone(),
                proxy_jump: h.proxy_jump.clone(),
                customer_id: None,
                notes: None,
                favorite: false,
                facts: None,
            })
            .is_ok()
        })
        .collect()
}

#[tauri::command]
pub fn save_project(
    db: State<Db>,
    watch: State<CiWatch>,
    sites: State<SiteWatch>,
    log_watch: State<LogWatch>,
    project: Project,
) -> CmdResult<()> {
    db.save_project(&project).map_err(err)?;
    // Repo-URL oder Domain könnte sich geändert haben
    watch.refresh();
    sites.refresh();
    // Server, path or stack decide which log files are counted
    log_watch.refresh();
    Ok(())
}

#[tauri::command]
pub fn delete_entity(db: State<Db>, kind: Table, id: String) -> CmdResult<bool> {
    db.delete(kind, &id).map_err(err)
}

#[tauri::command]
pub fn set_favorite(db: State<Db>, kind: Table, id: String, favorite: bool) -> CmdResult<()> {
    db.set_favorite(kind, &id, favorite).map_err(err)
}

/// Schreibt alle Daten als JSON in die vom Nutzer gewählte Datei
#[tauri::command]
pub fn export_backup(db: State<Db>, path: PathBuf, exported_at: String) -> CmdResult<()> {
    let backup = Backup {
        app: BACKUP_APP.into(),
        format_version: BACKUP_FORMAT_VERSION,
        exported_at,
        data: db.snapshot().map_err(err)?,
    };
    let json = serde_json::to_string_pretty(&backup).map_err(err)?;
    std::fs::write(&path, json).map_err(err)
}

/// Ersetzt alle Daten durch das Backup und gibt den neuen Stand zurück
#[tauri::command]
pub fn import_backup(db: State<Db>, path: PathBuf) -> CmdResult<Snapshot> {
    let raw = std::fs::read_to_string(&path).map_err(err)?;
    let backup: Backup = serde_json::from_str(&raw).map_err(|e| {
        tr!(
            "Not a valid Hostmoor backup: {e}",
            "Keine gültige Hostmoor-Sicherung: {e}"
        )
    })?;
    if backup.app != BACKUP_APP && backup.app != LEGACY_BACKUP_APP {
        return Err(tr!(
            "The file is not a Hostmoor backup.",
            "Die Datei ist keine Hostmoor-Sicherung."
        ));
    }
    if backup.format_version > BACKUP_FORMAT_VERSION {
        return Err(tr!(
            "The backup comes from a newer Hostmoor version.",
            "Die Sicherung stammt aus einer neueren Hostmoor-Version."
        ));
    }
    db.replace_all(&backup.data).map_err(err)?;
    db.snapshot().map_err(err)
}

fn find_server(db: &Db, id: &str) -> CmdResult<Server> {
    db.snapshot()
        .map_err(err)?
        .servers
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| tr!("Server not found", "Server nicht gefunden"))
}

/// Testet, ob sich die App per SSH am Server anmelden kann
#[tauri::command]
pub async fn test_connection(db: State<'_, Db>, id: String) -> CmdResult<ConnectionResult> {
    let server = find_server(&db, &id)?;
    Ok(ssh::test_connection(&server).await)
}

#[tauri::command]
pub fn set_deploy_script(db: State<Db>, id: String, script: Option<String>) -> CmdResult<()> {
    let script = script.filter(|s| !s.trim().is_empty());
    db.set_deploy_script(&id, script.as_deref()).map_err(err)
}

/// Log files of a project, one per line; empty resets to the suggestion for the stack
#[tauri::command]
pub fn set_log_paths(
    db: State<Db>,
    log_watch: State<LogWatch>,
    id: String,
    paths: Option<String>,
) -> CmdResult<()> {
    let paths = paths.filter(|s| !s.trim().is_empty());
    db.set_log_paths(&id, paths.as_deref()).map_err(err)?;
    log_watch.refresh();
    Ok(())
}

fn project_and_server(db: &Db, project_id: &str) -> CmdResult<(Project, Server)> {
    let project = db
        .snapshot()
        .map_err(err)?
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| tr!("Project not found", "Projekt nicht gefunden"))?;
    let server_id = project.server_id.clone().ok_or_else(|| {
        tr!(
            "No server is assigned to this project.",
            "Diesem Projekt ist kein Server zugeordnet."
        )
    })?;
    let server = find_server(db, &server_id)?;
    Ok((project, server))
}

/// Last lines of a log file on the project's server
#[tauri::command]
pub async fn read_log(
    db: State<'_, Db>,
    project_id: String,
    file: String,
    lines: u32,
) -> CmdResult<String> {
    let (project, server) = project_and_server(&db, &project_id)?;
    logs::read(&project, &server, &file, lines).await
}

/// Follows a log file; new lines arrive as `log-lines` events
#[tauri::command]
pub fn follow_log(
    app: AppHandle,
    db: State<Db>,
    project_id: String,
    file: String,
    stream_id: String,
) -> CmdResult<()> {
    let (project, server) = project_and_server(&db, &project_id)?;
    logs::follow(&app, &project, &server, &file, stream_id)
}

#[tauri::command]
pub fn stop_log(app: AppHandle, stream_id: String) -> bool {
    logs::stop(&app, &stream_id)
}

/// Latest error and warning counts of all projects' log files
#[tauri::command]
pub fn log_overview(log_watch: State<LogWatch>) -> Vec<LogStatus> {
    log_watch.overview()
}

/// Counts errors and warnings in the project's log files right away
#[tauri::command]
pub async fn check_logs(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
) -> CmdResult<LogStatus> {
    let (project, server) = project_and_server(&db, &project_id)?;
    log_watch::check_project(&app, &project, &server).await
}

/// Empties a log file on the server, then counts the project's logs again
#[tauri::command]
pub async fn clear_log(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    file: String,
) -> CmdResult<()> {
    let (project, server) = project_and_server(&db, &project_id)?;
    logs::clear(&project, &server, &file).await?;
    // The file is empty either way; a failed count only leaves the indicator stale
    let _ = log_watch::check_project(&app, &project, &server).await;
    Ok(())
}

#[tauri::command]
pub fn list_deploys(db: State<Db>, project_id: String) -> CmdResult<Vec<Deploy>> {
    db.deploys(&project_id).map_err(err)
}

#[tauri::command]
pub fn last_deploys(db: State<Db>) -> CmdResult<Vec<LastDeploy>> {
    db.last_deploys().map_err(err)
}

/// Startet das Deploy-Skript des Projekts auf seinem Server; die Ausgabe kommt als Events
#[tauri::command]
pub fn start_deploy(
    app: AppHandle,
    db: State<Db>,
    project_id: String,
    deploy_id: String,
    started_at: String,
) -> CmdResult<Deploy> {
    let snapshot = db.snapshot().map_err(err)?;
    let project = snapshot
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| tr!("Project not found", "Projekt nicht gefunden"))?;
    let server_id = project.server_id.as_deref().ok_or_else(|| {
        tr!(
            "The project has no server assigned.",
            "Dem Projekt ist kein Server zugeordnet."
        )
    })?;
    let server = snapshot
        .servers
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| tr!("Server not found", "Server nicht gefunden"))?;
    deploy::start(&app, &project, &server, deploy_id, started_at)
}

#[tauri::command]
pub fn cancel_deploy(app: AppHandle, project_id: String) -> bool {
    deploy::cancel(&app, &project_id)
}

/// Letzte Pipeline-Läufe zur Repo-URL des Projekts
#[tauri::command]
pub async fn ci_runs(db: State<'_, Db>, project_id: String) -> CmdResult<CiResult> {
    let repo_url = db
        .snapshot()
        .map_err(err)?
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| tr!("Project not found", "Projekt nicht gefunden"))?
        .repo_url
        .unwrap_or_default();
    Ok(ci::runs(&repo_url).await)
}

/// Speichert den Token für einen Host im Schlüsselbund; leer = entfernen
#[tauri::command]
pub fn set_ci_token(watch: State<CiWatch>, host: String, token: Option<String>) -> CmdResult<()> {
    ci::set_token(&host, token.as_deref())?;
    watch.refresh();
    Ok(())
}

/// Aktueller Stand der Hintergrund-Abfrage für die Seitenleiste
#[tauri::command]
pub fn ci_overview(watch: State<CiWatch>) -> Vec<ProjectCi> {
    watch.overview()
}

/// Latest certificate and reachability results of all project domains
#[tauri::command]
pub fn site_overview(sites: State<SiteWatch>) -> Vec<SiteStatus> {
    sites.overview()
}

/// Checks the domain of one project right away
#[tauri::command]
pub async fn check_site(app: AppHandle, project_id: String) -> CmdResult<SiteStatus> {
    site_watch::check_project(&app, &project_id).await
}

/// Öffnet das Terminal mit einer SSH-Sitzung, optional direkt im Projektordner
#[tauri::command]
pub fn open_terminal(
    db: State<Db>,
    id: String,
    dir: Option<String>,
    terminal: Option<String>,
) -> CmdResult<()> {
    let server = find_server(&db, &id)?;
    ssh::open_terminal(
        &server,
        dir.as_deref().filter(|d| !d.trim().is_empty()),
        terminal.as_deref(),
    )
}

/// Installierte Terminal-Apps für die Auswahl am Terminal-Button
#[tauri::command]
pub fn list_terminals() -> Vec<terminal::TerminalApp> {
    terminal::installed()
}

/// Ergebnis von „Jetzt prüfen“: bei Verbindungsproblemen die Ursache, sonst None
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    connection_error: Option<ConnectionResult>,
}

/// Liest PHP, Node, Kapazität usw. per SSH aus und speichert das Ergebnis
#[tauri::command]
pub async fn check_server(
    db: State<'_, Db>,
    id: String,
    checked_at: String,
) -> CmdResult<CheckOutcome> {
    let server = find_server(&db, &id)?;
    match check::check_server(&server, checked_at).await {
        Ok(facts) => {
            let json = serde_json::to_value(&facts).map_err(err)?;
            db.set_facts(&id, &json).map_err(err)?;
            Ok(CheckOutcome {
                connection_error: None,
            })
        }
        Err(CheckError::Connection(result)) => Ok(CheckOutcome {
            connection_error: Some(result),
        }),
        Err(CheckError::Output(message)) => Err(message),
    }
}

/// Language for backend texts; `None` follows the system. Returns "en" or "de".
#[tauri::command]
pub fn set_language(language: Option<String>) -> &'static str {
    crate::i18n::set(language.as_deref())
}
