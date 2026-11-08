# Windows Diagnostics

## Export one diagnostic file

When NGTManager opens, go to **Settings → Data → Export diagnostics**. The
download contains structured failure events first, followed by safe error
categories. It does not include the business backup, customer records, SQL
parameters, request bodies, full command lines, or raw process output. Missing,
damaged, unreadable, or over-limit records are listed in the file. Records
outside the retention period are not available for export.

If the page is unavailable but the manager executable still works, run this in
PowerShell:

```powershell
$diagnosticExe = Join-Path $env:LOCALAPPDATA 'NGTManager\tools\NGTManager.exe'
$diagnosticOutput = Join-Path ([Environment]::GetFolderPath('Desktop')) ("NGTManager-diagnostics-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
& $diagnosticExe diagnose-export $diagnosticOutput
```

The command creates a new file and refuses to overwrite an existing file or
write into NGTManager's business-data and backup folders. Choose another output
name if that timestamped file already exists.

## If the manager cannot run

For an installer failure before NGTManager's manager starts, open the `%TEMP%`
folder and copy the Inno Setup `Setup Log` file whose timestamp matches the
attempt. Setup logging is enabled in the installer, and the fallback error
message points to `%TEMP%`.

For an installed copy, the stable log directory is:

```text
%LOCALAPPDATA%\NGTManager\logs
```

It may contain older `manager.log`, `database.log`, `application.log`, migration,
or updater logs alongside versioned diagnostics under `diagnostics\events` and
`diagnostics\details`. Do not delete these files while collecting evidence.
Prefer the single exported diagnostic file when it is available. Raw legacy
logs can contain local paths and should only be shared privately with support.

If Windows Security or another security product quarantines NGTManager, record
the displayed detection name, affected file name, and time. Do not include
business backups in the diagnostic file or send them with diagnostic logs.
