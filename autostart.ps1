# Starts Attic in the background whenever you sign in to Windows.
#   Turn on:   powershell -ExecutionPolicy Bypass -File autostart.ps1
#   Turn off:  powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove
param([switch]$Remove)

$taskName = 'Attic Cloud Storage'

if ($Remove) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Attic will no longer start automatically.'
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) { throw 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS' }

# conhost --headless runs it with no console window on screen.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$PSScriptRoot\server.js`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'Attic is running and will start each time you sign in.'
