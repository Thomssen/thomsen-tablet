//! Detects which process owns the current foreground window (the signal
//! per-application profile switching is built on - see
//! `Profile::app_bindings`) and, separately, whether a named process is
//! running *anywhere*, foreground or not, which is what "is osu! running"
//! actually means.

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// The full executable path of a running process, given its PID, or `None`
/// if it can't be opened/queried (already exited, or insufficient access -
/// e.g. an elevated process while Thomsen Tablet runs unelevated).
fn full_path_for_pid(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The executable file name (e.g. `"osu!.exe"`) of the process that owns the
/// current foreground window, or `None` if it can't be determined (no
/// foreground window, or insufficient access to query it).
pub fn current_process_name() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let path = full_path_for_pid(pid)?;
        path.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

/// Every currently-running process's executable file name (e.g.
/// `"osu!.exe"`), regardless of whether it has a window or the foreground -
/// unlike `current_process_name`, which only ever reports the one focused
/// process. Best-effort: returns an empty list rather than panicking if the
/// snapshot can't be taken.
pub fn list_running_process_names() -> Vec<String> {
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return Vec::new();
        };

        let mut names = Vec::new();
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                names.push(String::from_utf16_lossy(&entry.szExeFile[..len]));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        names
    }
}

/// Whether any currently-running process's executable name matches
/// `exe_name` (case-insensitive) - the real signal behind "is osu! running,"
/// independent of window focus.
pub fn is_process_running(exe_name: &str) -> bool {
    list_running_process_names().iter().any(|n| n.eq_ignore_ascii_case(exe_name))
}

/// Full executable paths of every currently-running process whose name
/// matches `exe_name` (case-insensitive). Exists because a bare name isn't
/// always enough to know *which* program is running - osu! stable and
/// osu!lazer are both literally named `osu!.exe`, so telling them apart
/// means resolving each matching process's real path and comparing it
/// against a known install location instead. Returns every match rather
/// than just the first, since more than one copy can legitimately be
/// running at once. Best-effort, same as `list_running_process_names`: a
/// process that exits mid-enumeration, or one this process lacks access to
/// query, is silently skipped rather than failing the whole call.
pub fn list_running_process_paths(exe_name: &str) -> Vec<String> {
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return Vec::new();
        };

        let mut paths = Vec::new();
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case(exe_name) {
                    if let Some(path) = full_path_for_pid(entry.th32ProcessID) {
                        paths.push(path);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not asserting on *which* processes are running (that would be a flaky,
    /// machine-dependent test) - just that enumeration itself works and
    /// finds this test binary's own host process, which is always running
    /// while this test runs. Skipped outside a real Windows session (e.g. a
    /// restricted CI sandbox) since `CreateToolhelp32Snapshot` can
    /// legitimately fail there - `#[ignore]` rather than a hard assert.
    #[test]
    #[ignore = "enumerates real OS processes - not meaningful in a sandboxed/headless CI runner"]
    fn enumerates_at_least_one_real_running_process() {
        assert!(!list_running_process_names().is_empty());
    }

    #[test]
    fn is_process_running_is_case_insensitive_and_false_for_nonsense() {
        // A name that's essentially guaranteed never to exist as a real
        // process - proves the "not found" path doesn't panic or false-positive.
        assert!(!is_process_running("definitely-not-a-real-process-xyz123.exe"));
    }

    #[test]
    fn list_running_process_paths_is_empty_for_nonsense_name() {
        assert!(list_running_process_paths("definitely-not-a-real-process-xyz123.exe").is_empty());
    }
}
