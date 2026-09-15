# A1 check 2, second half: hold a SYSTEM_REQUIRED power request so the PC
# should NOT re-sleep after a wake. Run in its own terminal window, leave it
# running through the sleep/wake test, then Ctrl+C to release.
#
#   powershell -ExecutionPolicy Bypass -File a1-hold-awake.ps1
#
# This is the manual stand-in for PowerControl.holdAwake (implemented in A2).

Add-Type -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@ -Name PowerState -Namespace Forge

$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001

[Forge.PowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
Write-Host "Holding SYSTEM_REQUIRED. PC should stay awake. Press Ctrl+C to release."
try {
  while ($true) { Start-Sleep -Seconds 5 }
}
finally {
  [Forge.PowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
  Write-Host "Released."
}
