param(
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
    [string]$DailyTime = '09:00'
)

$ErrorActionPreference = 'Stop'

$taskName = 'AgentRouterDailyCheckin'
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $projectRoot 'src\cli.js'
$arguments = "--disable-warning=ExperimentalWarning `"$script`" run"

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $projectRoot
$triggers = @(
    New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    New-ScheduledTaskTrigger -Daily -At $DailyTime
)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 10) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description 'Agent Router GitHub OAuth daily check-in. Runs at logon and 09:00; SQLite prevents duplicate daily success.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

Write-Host "Scheduled task '$taskName' installed."
Write-Host "Daily run time: $DailyTime"
Write-Host "Run 'npm run setup' once before relying on the task."
