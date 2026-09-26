; Custom NSIS install/uninstall steps for Thomsen Tablet.
;
; Tauri's NSIS bundler already handles the ordinary install/uninstall work
; (copying files, shortcuts, the Add/Remove Programs entry). The one thing
; it doesn't know about is the autostart registry value that
; tauri-plugin-autostart (via the `auto-launch` crate) writes directly to
; HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run when "Start with
; Windows" is turned on in Settings - see src-tauri/src/lib.rs's
; `sync_autostart`. Left alone, uninstalling while that setting is on would
; leave a dangling registry value pointing at a deleted .exe.
;
; The value's name is the app's product name (`app.package_info().name`,
; i.e. `productName` in tauri.conf.json) - keep this in sync if that's ever
; renamed.

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Thomsen Tablet"
!macroend
