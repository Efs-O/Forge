# Print state: default printer, queue, and what can honestly be said about them.
#
# usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/print_status.ps1
#
# There is no PrintQueue module on the box this was written for, so Get-PrintQueue
# and Get-PrintJob do not exist there. Win32_Printer.PrinterStatus takes the values
# Win32 documents: 1 Other, 2 Unknown, 3 Idle, 4 Printing, 5 Warmup,
# 6 Stopped Printing, 7 Offline.

$ErrorActionPreference = "Continue"

$def = Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true }
if (-not $def) {
    "DEFAULT PRINTER : none configured"
} else {
    "DEFAULT PRINTER : " + $def.Name
    switch ($def.PrinterStatus) {
        1 { "PRINTER STATE : other" }
        2 { "PRINTER STATE : unknown" }
        3 { "PRINTER STATE : idle" }
        4 { "PRINTER STATE : printing" }
        5 { "PRINTER STATE : warmup" }
        6 { "PRINTER STATE : stopped printing" }
        7 { "PRINTER STATE : offline" }
        default { "PRINTER STATE : code " + $def.PrinterStatus }
    }
    if ($def.WorkOffline) { "PRINTER STATE : WorkOffline = true" }
}

$jobs = @(Get-CimInstance Win32_PrintJob)
if ($jobs.Count -eq 0) {
    "QUEUE           : empty"
    "VERDICT         : no job is waiting. An empty queue is also what a cancelled,"
    "                  failed or never-submitted job looks like from here - only the"
    "                  paper, or a screenshot of the driver, can tell those apart."
} else {
    foreach ($j in $jobs) {
        "QUEUE           : job " + $j.JobId + " | " + $j.Document +
            " | status=" + $j.Status + " | jobstatus=" + $j.JobStatus +
            " | submitted=" + $j.TimeSubmitted
    }
    "VERDICT         : still in the spooler. If it sits here for minutes, the driver is"
    "                  waiting in its own preview window - take a desktop_capture of the"
    "                  screen and click its Start Printing; this queue proves nothing."
}
