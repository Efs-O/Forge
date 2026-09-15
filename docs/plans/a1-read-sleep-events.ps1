# Read recent sleep / wake / dirty-shutdown events for A1 checks 2 and 4.
#   powershell -ExecutionPolicy Bypass -File a1-read-sleep-events.ps1
# Kernel-Power: 107 = resume from sleep, 6 = sleep, 42 = dirty shutdown.
# The 107 -> next 6 gap is "how long it stayed awake before re-sleeping" (check 2).
# The 107 timestamp is the resume point for the lead-time measurement (check 4).

$since = (Get-Date).AddHours(-6)
Get-WinEvent -FilterHashtable @{
  LogName = 'System'
  ProviderName = 'Microsoft-Windows-Kernel-Power'
  Id = 42, 6, 107
  StartTime = $since
} -ErrorAction SilentlyContinue |
  Sort-Object TimeCreated |
  Select-Object TimeCreated, Id,
    @{n='Meaning';e={ switch ($_.Id) { 107 {'RESUME from sleep'} 6 {'SLEEP'} 42 {'DIRTY shutdown'} } }} |
  Format-Table -AutoSize
