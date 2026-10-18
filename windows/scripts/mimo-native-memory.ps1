# SPDX-License-Identifier: MIT
param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [int]$Seconds = 60,
    [int]$IntervalSeconds = 5,
    [string]$OutputFile = 'verification/native-memory.csv'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputFile))
if (-not $outputPath.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The output must stay inside the project.'
}
$root = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId"
if (-not $root -or $root.Name -ne 'mimo.exe' -or -not $root.ExecutablePath.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Select the Mimo process built inside this project.'
}
New-Item -ItemType Directory -Path (Split-Path $outputPath) -Force | Out-Null
$samples = [Collections.Generic.List[object]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
do {
    $sampleUtc = [DateTime]::UtcNow.ToString('o')
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'mimo.exe' OR Name = 'msedgewebview2.exe'")
    $owned = [Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add($RootProcessId)
    do {
        $added = $false
        foreach ($process in $processes) {
            if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $added = $true }
        }
    } while ($added)
    $privateSets = @{}
    Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $privateSets[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
    foreach ($process in $processes) {
        if (-not $owned.Contains([int]$process.ProcessId)) { continue }
        $liveProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if (-not $liveProcess) { continue }
        $kind = if ($process.Name -eq 'mimo.exe') { 'app' } elseif ($process.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' }
        $samples.Add([pscustomobject]@{
            utc = $sampleUtc; pid = $process.ProcessId; kind = $kind
            privateMB = [math]::Round($liveProcess.PrivateMemorySize64 / 1MB, 2)
            privateWorkingSetMB = [math]::Round($privateSets[[int]$process.ProcessId] / 1MB, 2)
            workingSetMB = [math]::Round($liveProcess.WorkingSet64 / 1MB, 2)
            cpuSeconds = $liveProcess.TotalProcessorTime.TotalSeconds
        })
    }
    $samples | Export-Csv -LiteralPath $outputPath -NoTypeInformation
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds $IntervalSeconds
} while (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)
$totals = $samples | Group-Object utc | ForEach-Object {
    [pscustomobject]@{ utc = $_.Name; privateMB = [math]::Round(($_.Group | Measure-Object privateMB -Sum).Sum, 2)
        privateWorkingSetMB = [math]::Round(($_.Group | Measure-Object privateWorkingSetMB -Sum).Sum, 2)
        workingSetMB = [math]::Round(($_.Group | Measure-Object workingSetMB -Sum).Sum, 2) }
}
[pscustomobject]@{ output = $outputPath; samples = $totals.Count; first = $totals[0]; last = $totals[-1]
    peakPrivateMB = ($totals | Measure-Object privateMB -Maximum).Maximum
    peakPrivateWorkingSetMB = ($totals | Measure-Object privateWorkingSetMB -Maximum).Maximum } | ConvertTo-Json -Depth 3
