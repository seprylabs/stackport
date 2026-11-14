// First, so the tr! macro is available in all modules below
#[macro_use]
mod i18n;

mod check;
mod ci;
mod ci_watch;
mod commands;
mod db;
mod deploy;
mod log_watch;
mod logs;
mod models;
mod site_watch;
mod ssh;
mod ssh_config;
mod terminal;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Restart after installing an update
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // System language until the UI sends the user's choice
            i18n::set(None);
            // macOS: ~/Library/Application Support/com.seprylabs.hostmoor/hostmoor.db
            // Windows: %APPDATA%\com.seprylabs.hostmoor\hostmoor.db
            // Linux: ~/.local/share/com.seprylabs.hostmoor/hostmoor.db
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db::open(&dir.join("hostmoor.db"))?);
            app.manage(deploy::Running::default());
            app.manage(logs::Following::default());
            app.manage(ci_watch::CiWatch::default());
            ci_watch::start(app.handle().clone());
            app.manage(site_watch::SiteWatch::default());
            site_watch::start(app.handle().clone());
            app.manage(log_watch::LogWatch::default());
            log_watch::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_all,
            commands::save_customer,
            commands::save_server,
            commands::read_ssh_config,
            commands::save_project,
            commands::delete_entity,
            commands::set_favorite,
            commands::export_backup,
            commands::import_backup,
            commands::test_connection,
            commands::check_server,
            commands::open_terminal,
            commands::list_terminals,
            commands::set_deploy_script,
            commands::list_deploys,
            commands::last_deploys,
            commands::start_deploy,
            commands::cancel_deploy,
            commands::ci_runs,
            commands::set_ci_token,
            commands::ci_overview,
            commands::set_language,
            commands::site_overview,
            commands::check_site,
            commands::set_log_paths,
            commands::read_log,
            commands::follow_log,
            commands::stop_log,
            commands::log_overview,
            commands::check_logs,
            commands::clear_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
