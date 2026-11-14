# Changelog

All notable changes to Hostmoor (formerly StackPort) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Hostmoor follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Import servers from `~/.ssh/config`: Hostmoor lists the hosts from your SSH config, including `Include` files and `Host *` defaults, marks servers you already have and git hosts such as github.com, and adds the ones you pick. The file is only read, never changed.
- Jump hosts: a server can have a jump host (`ProxyJump`). Checks, deploys, logs and the terminal connect through it with `ssh -J`, and the connection help includes it in its commands.
- Log indicator: every 30 minutes Hostmoor counts the errors and warnings in each project's whole log files (Laravel/Monolog and PHP entries) over SSH and marks projects in the sidebar, red for errors and amber for warnings only. The log viewer shows the counts next to each file.
- Clear logs: the log viewer can empty a log file on the server after a confirmation. This is the only change the log viewer makes on the server.

## [1.2.0] - 2026-11-10

### Added

- SSL certificate watch: Hostmoor checks the certificate of every project domain every 6 hours and on demand, shows expiry, issuer and HTTP status in the project, marks expiring or invalid certificates in the sidebar and sends a notification 14 and 3 days before expiry.
- Log viewer: each project can list log files on its server (Laravel and WordPress paths are suggested). Hostmoor reads the last 500 lines over SSH, groups stack traces with their entry, filters by warnings and errors, searches, and can follow new lines live. It only reads; nothing on the server is changed.

## [1.1.0] - 2026-11-09

### Changed

- StackPort is now called Hostmoor, because another developer tool already uses the name StackPort. The repository moved to `seprylabs/hostmoor`; old links redirect.
- The app ID is now `com.seprylabs.hostmoor`, so Hostmoor starts with an empty database and does not see the data or CI tokens of StackPort. To move your data: in StackPort, export a backup from the sidebar menu, then restore it in Hostmoor and enter your CI tokens again. Backups from StackPort can be restored.
- On Windows, install Hostmoor with the installer and uninstall StackPort in the Windows settings; the in-app update installs Hostmoor next to StackPort without a Start menu entry.

## [1.0.1] - 2026-11-09

### Fixed

- "Check for updates" failed with "Command plugin:app|version not allowed by ACL" when StackPort was already up to date.

## [1.0.0] - 2026-11-09

First public release.

### Added

- Customers, projects and servers in one place, grouped in the sidebar, with favorites and search.
- Server check over SSH (OS, PHP, database, web server, disks and more), connection test with setup help, and a terminal button that opens an SSH session.
- Deploys per project with templates for Laravel and WordPress, live output, cancel and history.
- GitHub Actions and GitLab pipelines per project, polled in the background with notifications.
- Backup of all data as JSON, export and restore.
- English and German user interface. The language follows the system and can be switched in the sidebar menu.
- Windows and Linux support, including terminal integration and CI tokens in the system keychain on all platforms.
- Builds and installers for macOS, Windows and Linux on every release tag.
- CI checks on macOS, Windows and Linux for every pull request, plus dependency audits.
- English README with screenshots, contributing guide, code of conduct, and issue and pull request templates.
- Open-source license: AGPL-3.0.
- In-app updates: StackPort checks for new versions at startup and from the sidebar menu, and installs signed updates after you confirm.

[Unreleased]: https://github.com/seprylabs/hostmoor/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/seprylabs/hostmoor/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/seprylabs/hostmoor/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/seprylabs/hostmoor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/seprylabs/hostmoor/releases/tag/v1.0.0
