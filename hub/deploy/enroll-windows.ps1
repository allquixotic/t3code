# Supplied over the approved SSH connection; no remote repository or downloaded scripts.
param([string]$Archive, [string]$ArchiveHash, [string]$ConfigPath, [string]$ConfigHash, [string]$ExpectedHostname)
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\t3-hub'
$task = 'T3 Hub Protected Supervisor'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator installation required' }
if ([Net.Dns]::GetHostName() -cne $ExpectedHostname) { throw 'Selected hostname mismatch' }
if ((Test-Path $root) -or (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) { throw 'Existing enrollment requires administrator review; no files replaced' }
# Create and secure the parent before placing executable files or the public trust anchor in it.
New-Item -ItemType Directory $root | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect enrollment directory' }
$completed = $false
try {
  Copy-Item -LiteralPath $Archive -Destination "$root\runtime.tar"
  Copy-Item -LiteralPath $ConfigPath -Destination "$root\remote.json"
  if ((Get-FileHash "$root\runtime.tar" -Algorithm SHA256).Hash -ine $ArchiveHash -or (Get-FileHash "$root\remote.json" -Algorithm SHA256).Hash -ine $ConfigHash) { throw 'Enrollment checksum mismatch' }
  $c = Get-Content -Raw "$root\remote.json" | ConvertFrom-Json
  if ($c.ssh_user -cne [Environment]::UserName -or $c.runtime_user -cne $c.ssh_user -or $c.runtime_home -ine $env:USERPROFILE -or $c.root_directory -ine "$root\releases" -or $c.base_directory -ine "$root\state" -or $c.socket -ne '\\.\pipe\t3-hub-supervisor') { throw 'Remote identity or enrollment paths differ' }
  New-Item -ItemType Directory "$root\releases\bootstrap", "$root\state" | Out-Null
  & tar.exe -xf "$root\runtime.tar" -C "$root\releases\bootstrap"
  if ($LASTEXITCODE -ne 0) { throw 'Runtime extraction failed' }
  & "$root\releases\bootstrap\t3.exe" --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Runtime check failed' }
  [IO.File]::WriteAllText("$root\connect.ps1", "& '$root\releases\bootstrap\t3.exe' __hub-agent @args --config '$root\remote.json'`r`nexit `$LASTEXITCODE`r`n")
  # S4U runs as the enrolled account without storing its password, never as SYSTEM.
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
  $action = New-ScheduledTaskAction -Execute "$root\releases\bootstrap\t3.exe" -Argument "__hub-agent supervise --config `"$root\remote.json`"" -WorkingDirectory $root
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  # Rollback exists before the service is registered. Keep release/state for inspection.
  [IO.File]::WriteAllText("$root\rollback-enrollment.ps1", "`$ErrorActionPreference='Stop'`r`nStop-ScheduledTask -TaskName '$task'`r`nUnregister-ScheduledTask -TaskName '$task' -Confirm:`$false`r`nRemove-Item '$root\connect.ps1', '$root\remote.json'`r`n")
  & icacls.exe $root /setowner '*S-1-5-32-544' /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect enrollment ownership' }
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
  Start-ScheduledTask -TaskName $task
  # The connecting transport verifies the named pipe and hello under the approved deadline.
  Remove-Item "$root\runtime.tar"
  $completed = $true
  Write-Output 'ENROLLED: protected supervisor installed; readiness is verified on connection.'
} finally {
  if (-not $completed) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Enrollment incomplete; protected staging retained for administrator inspection.'
  }
}
