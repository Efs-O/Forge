# Throwaway A1 wake test (check 2 and check 3).
# Interactive-user principal (no elevation needed). No-op action: the wake is the point.
#
# One-shot, N minutes out (check 2) -- mirrors the production TimeTrigger shape:
#   powershell -ExecutionPolicy Bypass -File a1-arm-test-wake.ps1 3
#
# Daily, every day at HH:MM (check 3 -- must fire two mornings in a row):
#   powershell -ExecutionPolicy Bypass -File a1-arm-test-wake.ps1 -Daily -At 06:00
#
# Remove afterwards:  schtasks /delete /tn ForgeA1Test /f

param(
  [int]$Minutes = 3,
  [switch]$Daily,
  [string]$At = '06:00'
)

function LocalIso([DateTime]$d) {
  return $d.ToString('yyyy-MM-ddTHH:mm:ss')
}

$now = Get-Date
if ($Daily) {
  $t = $At -split ':'
  $start = $now.Date.AddHours([int]$t[0]).AddMinutes([int]$t[1])
  if ($start -le $now) { $start = $start.AddDays(1) }   # today's slot already passed
  $startBoundary = LocalIso $start
  $endBoundary = LocalIso $start
  $trigger = @"
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
"@
  $mode = "DAILY at $At"
} else {
  $start = $now.AddMinutes($Minutes)
  $startBoundary = LocalIso $start
  $endBoundary = LocalIso $start.AddMinutes(1)
  $trigger = @"
    <TimeTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <EndBoundary>$endBoundary</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
"@
  $mode = "one-shot in $Minutes min"
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Forge A1 throwaway wake test</Description></RegistrationInfo>
  <Triggers>
$trigger
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <WakeToRun>true</WakeToRun>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>cmd.exe</Command><Arguments>/c exit</Arguments></Exec>
  </Actions>
</Task>
"@

$path = Join-Path $env:TEMP 'forge-a1-test.xml'
Set-Content -LiteralPath $path -Encoding Unicode -Value $xml
try {
  schtasks /create /tn "ForgeA1Test" /xml $path /f
  if ($LASTEXITCODE -ne 0) { Write-Error "schtasks exited $LASTEXITCODE. XML was:"; Write-Host $xml }
  else { Write-Host "Registered ForgeA1Test: $mode (first fire $startBoundary local). Query: schtasks /query /tn ForgeA1Test /fo LIST" }
}
finally { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }
