//! Counts errors and warnings in the log files of every project while the app runs.
//!
//! Every 30 minutes (and right away after log paths or a project change) each project
//! with a server gets one ssh call that counts error and warning entries in its whole
//! log files. The result goes to the UI as the `log-update` event, for the indicator
//! in the sidebar and the log viewer. A failed connection keeps the last result.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::db::Db;
use crate::logs::{self, FileCount};
use crate::models::{Project, Server};

const INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    pub project_id: String,
    /// Unix milliseconds
    pub checked_at: u64,
    /// Readable log files; missing ones are left out
    pub files: Vec<FileCount>,
}

/// Shared state: latest counts for the UI and a signal to count again right away
#[derive(Default)]
pub struct LogWatch {
    overview: Mutex<Vec<LogStatus>>,
    wake: Notify,
}

impl LogWatch {
    pub fn overview(&self) -> Vec<LogStatus> {
        self.overview.lock().expect("log mutex poisoned").clone()
    }

    /// Count again right away, e.g. after the log paths changed
    pub fn refresh(&self) {
        self.wake.notify_one();
    }
}

fn record(app: &AppHandle, status: LogStatus) {
    let watch = app.state::<LogWatch>();
    let overview = {
        let mut current = watch.overview.lock().expect("log mutex poisoned");
        current.retain(|s| s.project_id != status.project_id);
        current.push(status);
        current.clone()
    };
    let _ = app.emit("log-update", &overview);
}

/// Counts the log files of one project now and sends the result to the UI
pub async fn check_project(
    app: &AppHandle,
    project: &Project,
    server: &Server,
) -> Result<LogStatus, String> {
    let files = logs::count(project, server).await?;
    let status = LogStatus {
        project_id: project.id.clone(),
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        files,
    };
    record(app, status.clone());
    Ok(status)
}

async fn cycle(app: &AppHandle) {
    let Ok(snapshot) = app.state::<Db>().snapshot() else {
        return;
    };
    let projects: Vec<(Project, Server)> = snapshot
        .projects
        .into_iter()
        .filter(|p| !logs::paths(p).is_empty())
        .filter_map(|p| {
            let server = snapshot
                .servers
                .iter()
                .find(|s| Some(&s.id) == p.server_id.as_ref())?
                .clone();
            Some((p, server))
        })
        .collect();

    // Drop results of deleted projects, removed servers or emptied path lists
    {
        let watch = app.state::<LogWatch>();
        let mut current = watch.overview.lock().expect("log mutex poisoned");
        let before = current.len();
        current.retain(|s| projects.iter().any(|(p, _)| p.id == s.project_id));
        if current.len() != before {
            let _ = app.emit("log-update", &*current);
        }
    }

    for (project, server) in &projects {
        // Offline or no access: keep the last result
        let _ = check_project(app, project, server).await;
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            cycle(&app).await;
            let watch = app.state::<LogWatch>();
            tokio::select! {
                _ = tokio::time::sleep(INTERVAL) => {}
                _ = watch.wake.notified() => {}
            }
        }
    });
}
