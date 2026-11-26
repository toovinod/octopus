use std::{
  io::Read,
  process::{Command, Stdio},
  sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Mutex,
  },
  thread,
  time::Duration,
};

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};
use tokio::sync::watch;

// Must match READY_LINE_PREFIX in apps/daemon/src/server/DaemonServer.ts.
const READY_LINE_PREFIX: &str = "OCTOPUS_DAEMON_READY ";

// Must match FAILED_LINE_PREFIX in apps/daemon/src/server/runDaemon.ts.
const FAILED_LINE_PREFIX: &str = "OCTOPUS_DAEMON_FAILED ";

// Longer than octopusd's own 8 second shutdown deadline, so a daemon that is still stopping its
// children is not cut off. Only a daemon that hangs past its own deadline gets killed.
const DAEMON_EXIT_WAIT: Duration = Duration::from_secs(10);

// Must match the event the webview listens for in apps/web/lib/daemonRuntime.ts.
const DAEMON_STOPPED_EVENT: &str = "daemon-stopped";

#[derive(Clone, Debug, PartialEq, Serialize)]
struct DaemonConnection {
  url: String,
  token: String,
}

// A stopped daemon has no connection, so nothing hands out the URL and token of a process that is gone.
// It keeps the reason octopusd gave for failing, when it gave one, to show the user.
#[derive(Clone, Debug, PartialEq)]
enum DaemonStatus {
  Starting,
  Ready(DaemonConnection),
  Stopped(Option<String>),
}

impl DaemonStatus {
  // None while octopusd is still starting, so callers keep waiting.
  fn connection(&self) -> Option<Result<DaemonConnection, String>> {
    match self {
      DaemonStatus::Starting => None,
      DaemonStatus::Ready(connection) => Some(Ok(connection.clone())),
      DaemonStatus::Stopped(reason) => Some(Err(reason.clone().unwrap_or_else(|| "The daemon stopped".to_string()))),
    }
  }

  // Only a stopped daemon is started again, so two restart calls never run two daemons on one data dir.
  fn begin_restart(&mut self) -> bool {
    if !matches!(self, DaemonStatus::Stopped(_)) {
      return false;
    }
    *self = DaemonStatus::Starting;
    true
  }
}

// The status an event from octopusd moves to, or None when the event does not change it. Only a starting
// daemon becomes ready, so a later line that happens to look like the ready line cannot change the URL.
fn status_after(
  event: &CommandEvent,
  token: &str,
  current: &DaemonStatus,
  failure: Option<&str>,
) -> Option<DaemonStatus> {
  match event {
    CommandEvent::Stdout(line) if *current == DaemonStatus::Starting => String::from_utf8_lossy(line)
      .trim()
      .strip_prefix(READY_LINE_PREFIX)
      .map(|url| DaemonStatus::Ready(DaemonConnection { url: url.to_string(), token: token.to_string() })),
    // The plugin sends this only after it reaped the process, so the old octopusd and its data dir lock are gone.
    CommandEvent::Terminated(_) => Some(DaemonStatus::Stopped(failure.map(str::to_string))),
    _ => None,
  }
}

// The user-facing reason octopusd prints before it exits with an error.
fn failure_reason(event: &CommandEvent) -> Option<String> {
  let CommandEvent::Stdout(line) = event else { return None };
  String::from_utf8_lossy(line).trim().strip_prefix(FAILED_LINE_PREFIX).map(str::to_string)
}

// What the webview reads when it may have missed the stop event: it fires once, and can fire before the
// webview listens, such as when octopusd fails at launch.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct StoppedDaemon {
  reason: Option<String>,
}

// Quitting stops octopusd on purpose, so only an unexpected stop is reported.
fn stopped_report(status: &DaemonStatus, quitting: bool) -> Option<StoppedDaemon> {
  match status {
    DaemonStatus::Stopped(reason) if !quitting => Some(StoppedDaemon { reason: reason.clone() }),
    _ => None,
  }
}

struct Daemon {
  status: watch::Sender<DaemonStatus>,
  // With the pid read at spawn: `CommandChild::pid` waits on a lock the plugin's waiter thread
  // can hold while octopusd is stopped, and quitting runs on the UI thread.
  child: Mutex<Option<(CommandChild, u32)>>,
  quitting: AtomicBool,
  // Set when octopusd had to start with the app's own minimal environment, so the webview can say why agents,
  // git or gh may not be found.
  login_env_missing: AtomicBool,
}

// What closing the window does. On macOS the app stays in the dock and agents keep working, as macOS apps
// do. Elsewhere there is no dock to reopen it from, so closing the window quits.
#[derive(Debug, PartialEq)]
enum CloseAction {
  Hide,
  Quit,
}

const CLOSE_ACTION: CloseAction = if cfg!(target_os = "macos") { CloseAction::Hide } else { CloseAction::Quit };

// Set by the webview while turns run or approvals wait, with the text to show before quitting. The shell
// does not track sessions itself. Starting empty means a webview that never reports cannot block a quit.
struct QuitWarning(Mutex<Option<String>>);

#[tauri::command]
fn set_quit_warning(warning: Option<String>, quit_warning: State<'_, QuitWarning>) {
  if let Ok(mut slot) = quit_warning.0.lock() {
    *slot = warning;
  }
}

async fn wait_for_connection(daemon: &Daemon) -> Result<DaemonConnection, String> {
  let mut status = daemon.status.subscribe();
  let settled = status.wait_for(|status| status.connection().is_some()).await.map_err(|error| error.to_string())?;
  settled.connection().expect("checked by wait_for")
}

#[tauri::command]
fn daemon_stopped(daemon: State<'_, Daemon>) -> Option<StoppedDaemon> {
  stopped_report(&daemon.status.borrow(), daemon.quitting.load(Ordering::SeqCst))
}

#[tauri::command]
fn login_env_missing(daemon: State<'_, Daemon>) -> bool {
  daemon.login_env_missing.load(Ordering::SeqCst)
}

#[tauri::command]
async fn daemon_connection(daemon: State<'_, Daemon>) -> Result<DaemonConnection, String> {
  wait_for_connection(&daemon).await
}

// Started only by the user from the webview, never automatically, so a daemon that crashes on start
// does not restart in a loop.
#[tauri::command]
async fn restart_daemon(app: tauri::AppHandle, daemon: State<'_, Daemon>) -> Result<DaemonConnection, String> {
  if daemon.status.send_if_modified(DaemonStatus::begin_restart) {
    drop(take_daemon_child(&app));
    start_daemon(app.clone());
  }
  wait_for_connection(&daemon).await
}

// A fresh secret per launch, so only this window can talk to this daemon.
fn generate_token() -> Result<String, getrandom::Error> {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes)?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Printed before the environment, so anything the shell's startup files print is skipped.
const ENV_MARKER: &[u8] = b"\0OCTOPUS_LOGIN_ENV\0";
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
// Far more than any real environment, so a runaway startup file cannot fill memory.
const LOGIN_SHELL_OUTPUT_LIMIT: u64 = 1024 * 1024;
// Describe the shell that printed them, not the daemon.
const SHELL_SESSION_VARIABLES: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];

// An app opened from Finder or a desktop launcher gets a minimal environment without the user's PATH (so no
// `claude`, `codex`, `node` or `gh`), proxy settings or tool variables. Their login shell sets the real ones.
fn login_shell_env() -> Option<Vec<(String, String)>> {
  let shell = std::env::var("SHELL").ok()?;
  // Interactive too, because many people set PATH in .zshrc or .bashrc.
  let mut command = Command::new(shell);
  command.args(["-ilc", r#"printf '\0OCTOPUS_LOGIN_ENV\0'; env -0"#]);
  let output = output_within(command, LOGIN_SHELL_TIMEOUT)?;
  Some(parse_login_env(&output)).filter(|variables| !variables.is_empty())
}

// Reads on another thread: a startup file can leave a background process holding stdout open, and then
// the read never ends. The deadline covers the read too, and the thread is left to finish on its own.
fn output_within(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
  let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
  let stdout = child.stdout.take()?;
  let (sender, receiver) = mpsc::channel();
  thread::spawn(move || {
    let mut output = Vec::new();
    let read = stdout.take(LOGIN_SHELL_OUTPUT_LIMIT).read_to_end(&mut output).map(|_| output);
    let _ = sender.send(read);
  });
  let output = receiver.recv_timeout(timeout);
  let _ = child.kill();
  let _ = child.wait();
  output.ok()?.ok()
}

// `env -0` output after the marker: NAME=value entries, each ended by a NUL, values can hold newlines.
fn parse_login_env(output: &[u8]) -> Vec<(String, String)> {
  let Some(start) = output.windows(ENV_MARKER.len()).position(|window| window == ENV_MARKER) else {
    return Vec::new();
  };
  output[start + ENV_MARKER.len()..]
    .split(|byte| *byte == 0)
    .filter_map(|entry| std::str::from_utf8(entry).ok()?.split_once('='))
    .filter(|(name, _)| !name.is_empty() && !SHELL_SESSION_VARIABLES.contains(name))
    .map(|(name, value)| (name.to_string(), value.to_string()))
    .collect()
}

fn spawn_daemon(app: &tauri::AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
  let token = generate_token()?;
  let mut sidecar = app.shell().sidecar("octopusd")?;
  let login_env = login_shell_env();
  app.state::<Daemon>().login_env_missing.store(login_env.is_none(), Ordering::SeqCst);
  match login_env {
    Some(variables) => sidecar = sidecar.envs(variables),
    None => log::warn!("Could not read the login shell's environment, so octopusd keeps the app's own"),
  }
  // A debug build loads the web dev server, so octopusd must accept that page's origin as well as the app's own.
  if cfg!(debug_assertions)
    && let Some(dev_url) = &app.config().build.dev_url
  {
    sidecar = sidecar.env("OCTOPUS_DAEMON_DEV_ORIGIN", dev_url.origin().ascii_serialization());
  }
  let (mut events, mut child) = sidecar.spawn()?;
  // Through stdin, not the environment: agents, scripts and git inherit the daemon's environment.
  child.write(format!("{token}\n").as_bytes())?;

  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut failure = None;
    while let Some(event) = events.recv().await {
      let daemon = app.state::<Daemon>();
      failure = failure_reason(&event).or(failure);
      let status = status_after(&event, &token, &daemon.status.borrow(), failure.as_deref());
      match &event {
        CommandEvent::Stdout(line) if status.is_none() => {
          log::info!("octopusd: {}", String::from_utf8_lossy(line).trim_end())
        }
        CommandEvent::Stderr(line) => log::warn!("octopusd: {}", String::from_utf8_lossy(line).trim_end()),
        CommandEvent::Terminated(payload) => log::info!("octopusd exited: {payload:?}"),
        _ => {}
      }
      let Some(status) = status else { continue };
      let report = stopped_report(&status, daemon.quitting.load(Ordering::SeqCst));
      daemon.status.send_replace(status);
      if let Some(report) = report {
        let _ = app.emit(DAEMON_STOPPED_EVENT, report.reason);
      }
    }
  });

  Ok(child)
}

// Reading the login shell's PATH can take seconds, so the window does not wait for it.
fn start_daemon(app: tauri::AppHandle) {
  tauri::async_runtime::spawn_blocking(move || {
    let daemon = app.state::<Daemon>();
    match spawn_daemon(&app) {
      Ok(child) => {
        let pid = child.pid();
        if let Ok(mut slot) = daemon.child.lock() {
          *slot = Some((child, pid));
        }
      }
      Err(error) => {
        log::error!("Could not start octopusd: {error}");
        daemon.status.send_replace(DaemonStatus::Stopped(None));
      }
    }
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // First, so a second launch hands over to the running app before it starts a second daemon on the same
    // data dir, which would fail and leave that window stuck on "The daemon stopped".
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_windows(app)))
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .on_menu_event(|app, event| {
      if event.id() == CLOSE_WINDOW_ID
        && let Some(window) = app.webview_windows().values().find(|window| window.is_focused().unwrap_or(false))
      {
        let _ = window.close();
      }
    })
    .setup(|app| {
      let (status, _) = watch::channel(DaemonStatus::Starting);
      app.manage(Daemon {
        status,
        child: Mutex::new(None),
        quitting: AtomicBool::new(false),
        login_env_missing: AtomicBool::new(false),
      });
      app.manage(QuitWarning(Mutex::new(None)));
      #[cfg(target_os = "macos")]
      app.set_menu(app_menu(app.handle())?)?;
      start_daemon(app.handle().clone());
      Ok(())
    })
    .on_window_event(|window, event| {
      let WindowEvent::CloseRequested { api, .. } = event else { return };
      // Quitting closes the windows itself.
      if window.state::<Daemon>().quitting.load(Ordering::SeqCst) {
        return;
      }
      api.prevent_close();
      match CLOSE_ACTION {
        CloseAction::Hide => {
          let _ = window.hide();
        }
        CloseAction::Quit => request_quit(window.app_handle()),
      }
    })
    .invoke_handler(tauri::generate_handler![
      daemon_connection,
      daemon_stopped,
      login_env_missing,
      restart_daemon,
      set_quit_warning
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      // Holding every exit back would also cancel a macOS logout or restart, so it is held only to ask first.
      // Otherwise the app exits now, and `RunEvent::Exit` stops octopusd.
      // Our own `app.exit` in `quit` asks again, and that one goes through.
      RunEvent::ExitRequested { api, .. } => {
        let daemon = app.state::<Daemon>();
        if holds_exit(daemon.quitting.load(Ordering::SeqCst), quit_warning(app).as_deref()) {
          api.prevent_exit();
          request_quit(app);
        } else {
          // So octopusd stopping is not reported to the webview as a crash.
          daemon.quitting.store(true, Ordering::SeqCst);
        }
      }
      // A click on the dock icon brings back the window that closing hid.
      #[cfg(target_os = "macos")]
      RunEvent::Reopen { has_visible_windows: false, .. } => show_windows(app),
      // An exit nothing held back, such as a logout, still waits for octopusd and kills it if it hangs. After
      // `quit` the daemon is already stopped and this returns at once. A crash closes stdin too.
      RunEvent::Exit => tauri::async_runtime::block_on(stop_daemon(app)),
      _ => {}
    });
}

// Brings back windows that closing hid, in front of other apps.
fn show_windows(app: &tauri::AppHandle) {
  for window in app.webview_windows().values() {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

const CLOSE_WINDOW_ID: &str = "close-window";

// The default menu, except that Close Window moves from ⌘W to ⇧⌘W. Menu shortcuts reach the app before
// the page, so with ⌘W on Close Window the page's "close the chat tab" shortcut never ran on its own.
// Only macOS gets a default menu.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::default(app)?;
  let close_window = PredefinedMenuItem::close_window(app, None)?.text()?;
  for item in menu.items()? {
    let MenuItemKind::Submenu(submenu) = item else { continue };
    for entry in submenu.items()? {
      if let MenuItemKind::Predefined(predefined) = &entry
        && predefined.text()? == close_window
      {
        submenu.remove(&entry)?;
        let replacement = MenuItem::with_id(app, CLOSE_WINDOW_ID, &close_window, true, Some("CmdOrCtrl+Shift+W"))?;
        submenu.append(&replacement)?;
      }
    }
  }
  Ok(menu)
}

fn quit_warning(app: &tauri::AppHandle) -> Option<String> {
  app.state::<QuitWarning>().0.lock().ok().and_then(|warning| warning.clone())
}

// An exit is held back only while it is not already quitting and there is something to ask about.
fn holds_exit(quitting: bool, warning: Option<&str>) -> bool {
  !quitting && warning.is_some()
}

// Asks first when the webview reported running turns or pending approvals.
fn request_quit(app: &tauri::AppHandle) {
  let Some(warning) = quit_warning(app) else {
    quit(app);
    return;
  };
  let handle = app.clone();
  app
    .dialog()
    .message(warning)
    .title("Quit Octopus?")
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom("Quit".to_string(), "Cancel".to_string()))
    .show(move |confirmed| {
      if confirmed {
        quit(&handle);
      }
    });
}

fn take_daemon_child(app: &tauri::AppHandle) -> Option<(CommandChild, u32)> {
  app.state::<Daemon>().child.lock().ok().and_then(|mut child| child.take())
}

// Dropping the child closes the daemon's stdin, and it shuts down and stops everything it started. `kill()`
// would SIGKILL it at once and orphan its children, so this waits for the daemon to exit and kills it only
// when it hangs.
async fn stop_daemon(app: &tauri::AppHandle) {
  let Some((child, pid)) = take_daemon_child(app) else { return };
  let mut status = app.state::<Daemon>().status.subscribe();
  drop(child);
  let stopped = status.wait_for(|status| matches!(status, DaemonStatus::Stopped(_)));
  if tokio::time::timeout(DAEMON_EXIT_WAIT, stopped).await.is_err() {
    log::error!("octopusd did not exit within {DAEMON_EXIT_WAIT:?}, killing it");
    // Still octopusd's pid: it has not exited, so the pid cannot have been reused. The children
    // it leaves are stopped by the next octopusd from its process registry.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
  }
}

// Hides the windows, stops the daemon off the UI thread, then exits.
fn quit(app: &tauri::AppHandle) {
  // Two quit requests, say from two dialogs, stop the daemon once.
  if app.state::<Daemon>().quitting.swap(true, Ordering::SeqCst) {
    return;
  }
  for window in app.webview_windows().values() {
    let _ = window.hide();
  }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    stop_daemon(&app).await;
    app.exit(0);
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri_plugin_shell::process::TerminatedPayload;

  fn connection() -> DaemonConnection {
    DaemonConnection { url: "http://127.0.0.1:4799".to_string(), token: "secret".to_string() }
  }

  fn exited() -> CommandEvent {
    CommandEvent::Terminated(TerminatedPayload { code: Some(1), signal: None })
  }

  #[test]
  fn the_ready_line_makes_the_daemon_ready() {
    let line = CommandEvent::Stdout(b"OCTOPUS_DAEMON_READY http://127.0.0.1:4799\n".to_vec());
    let starting = DaemonStatus::Starting;
    assert_eq!(status_after(&line, "secret", &starting, None), Some(DaemonStatus::Ready(connection())));
    assert_eq!(status_after(&CommandEvent::Stdout(b"listening\n".to_vec()), "secret", &starting, None), None);
  }

  #[test]
  fn a_ready_line_after_start_up_changes_nothing() {
    let line = CommandEvent::Stdout(b"OCTOPUS_DAEMON_READY http://evil.example\n".to_vec());
    assert_eq!(status_after(&line, "secret", &DaemonStatus::Ready(connection()), None), None);
  }

  #[test]
  fn an_exited_daemon_stops_handing_out_its_connection() {
    let status = status_after(&exited(), "secret", &DaemonStatus::Ready(connection()), None);
    assert_eq!(status, Some(DaemonStatus::Stopped(None)));
    assert!(matches!(status.and_then(|status| status.connection()), Some(Err(_))));
  }

  #[test]
  fn a_daemon_that_failed_says_why() {
    let line = CommandEvent::Stdout(b"OCTOPUS_DAEMON_FAILED Another Octopus is already running.\n".to_vec());
    let reason = failure_reason(&line);
    assert_eq!(reason.as_deref(), Some("Another Octopus is already running."));
    assert_eq!(failure_reason(&CommandEvent::Stdout(b"listening\n".to_vec())), None);
    let status = status_after(&exited(), "secret", &DaemonStatus::Starting, reason.as_deref());
    assert_eq!(
      status.and_then(|status| status.connection()),
      Some(Err("Another Octopus is already running.".to_string()))
    );
  }

  #[test]
  fn the_login_environment_skips_startup_output_and_shell_variables() {
    let output =
      b"Welcome!\n\0OCTOPUS_LOGIN_ENV\0PATH=/opt/bin:/usr/bin\0NOTE=two\nlines\0PWD=/home\0SHLVL=2\0EMPTY=\0";
    assert_eq!(
      parse_login_env(output),
      vec![
        ("PATH".to_string(), "/opt/bin:/usr/bin".to_string()),
        ("NOTE".to_string(), "two\nlines".to_string()),
        ("EMPTY".to_string(), String::new()),
      ]
    );
    assert!(parse_login_env(b"PATH=/usr/bin\0").is_empty());
  }

  #[test]
  fn reading_a_shell_gives_up_when_a_background_child_holds_its_output() {
    let mut command = Command::new("sh");
    command.args(["-c", "printf done; sleep 30 &"]);
    let started = std::time::Instant::now();
    assert_eq!(output_within(command, Duration::from_millis(300)), None);
    assert!(started.elapsed() < Duration::from_secs(5));

    let mut command = Command::new("sh");
    command.args(["-c", "printf done"]);
    assert_eq!(output_within(command, Duration::from_secs(5)), Some(b"done".to_vec()));
  }

  #[test]
  fn closing_the_window_hides_it_only_on_macos() {
    let expected = if cfg!(target_os = "macos") { CloseAction::Hide } else { CloseAction::Quit };
    assert_eq!(CLOSE_ACTION, expected);
  }

  #[test]
  fn a_stop_is_reported_until_the_daemon_starts_again_unless_the_app_is_quitting() {
    let stopped = DaemonStatus::Stopped(Some("Another Octopus is already running.".to_string()));
    assert_eq!(
      stopped_report(&stopped, false),
      Some(StoppedDaemon { reason: Some("Another Octopus is already running.".to_string()) })
    );
    assert_eq!(stopped_report(&stopped, true), None);
    assert_eq!(stopped_report(&DaemonStatus::Starting, false), None);
    assert_eq!(stopped_report(&DaemonStatus::Ready(connection()), false), None);
  }

  #[test]
  fn an_exit_is_held_back_only_to_ask_first() {
    assert!(holds_exit(false, Some("1 chat is working. Quitting stops it.")));
    assert!(!holds_exit(false, None));
    assert!(!holds_exit(true, Some("1 chat is working. Quitting stops it.")));
  }

  #[test]
  fn only_a_stopped_daemon_restarts() {
    let mut stopped = DaemonStatus::Stopped(None);
    assert!(stopped.begin_restart());
    assert_eq!(stopped, DaemonStatus::Starting);
    assert!(stopped.connection().is_none());

    let mut starting = DaemonStatus::Starting;
    assert!(!starting.begin_restart());
    let mut ready = DaemonStatus::Ready(connection());
    assert!(!ready.begin_restart());
    assert_eq!(ready, DaemonStatus::Ready(connection()));
  }
}
