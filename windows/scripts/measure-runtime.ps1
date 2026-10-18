# SPDX-License-Identifier: MIT
[CmdletBinding(DefaultParameterSetName = 'Renderer')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Renderer')] [ValidateRange(1, 2147483647)] [int] $RendererId,
    [Parameter(Mandatory = $true, ParameterSetName = 'App')] [ValidateRange(1, 2147483647)] [int] $AppProcessId,
    [ValidateRange(1, 60)] [int] $Minutes = 15,
    [ValidateRange(0, 3600)] [int] $Seconds = 0,
    [ValidateRange(1, 60)] [int] $IntervalSeconds = 5,
    [string] $OutputPath = (Join-Path $PSScriptRoot '../target/runtime-memory.csv')
)

$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw "Choose a new OutputPath; an existing measurement will not be overwritten: $output" }
$rootId = if ($PSCmdlet.ParameterSetName -eq 'App') { $AppProcessId } else { $RendererId }
$rootProcess = Get-Process -Id $rootId
if ($PSCmdlet.ParameterSetName -eq 'App') {
    if ($rootProcess.ProcessName -ne 'mimo') { throw 'AppProcessId must identify the running Mimo mimo.exe process.' }
} else {
    if ($rootProcess.ProcessName -ne 'msedgewebview2') { throw 'RendererId must identify the Mimo WebView2 renderer in Task Manager.' }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $RendererId"
    if ($command.CommandLine -notmatch '--type=renderer(?:\s|$)') { throw 'Select the renderer rather than the browser, GPU or utility process.' }
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
$deadline = if ($Seconds -gt 0) { [DateTime]::UtcNow.AddSeconds($Seconds) } else { [DateTime]::UtcNow.AddMinutes($Minutes) }
$previousAt = [DateTime]::UtcNow
$previousCpu = @{}
$rows = 0; $peakPrivate = 0; $peakWorkingSet = 0
Write-Host "Sampling Mimo process $rootId into $output. PrivateMB includes its own process tree in App mode; working set can count shared pages more than once."

while ([DateTime]::UtcNow -lt $deadline) {
    try { $rootProcess.Refresh(); if ($rootProcess.HasExited) { break } } catch { break }
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($rootId)
    if ($PSCmdlet.ParameterSetName -eq 'App') {
        $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Select-Object ProcessId, ParentProcessId)
        do {
            $found = $false
            foreach ($candidate in $candidates) {
                if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) { $found = $true }
            }
        } while ($found)
    }
    $privateBytes = 0; $workingBytes = 0; $cpuDelta = 0; $handles = 0; $count = 0
    $at = [DateTime]::UtcNow
    foreach ($processId in $ids) {
        $sampled = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $sampled) { continue }
        $cpu = $sampled.TotalProcessorTime.TotalSeconds
        if ($previousCpu.ContainsKey($processId)) { $cpuDelta += [Math]::Max(0, $cpu - $previousCpu[$processId]) }
        $previousCpu[$processId] = $cpu
        $privateBytes += $sampled.PrivateMemorySize64; $workingBytes += $sampled.WorkingSet64
        $handles += $sampled.HandleCount; $count++
    }
    $elapsed = [Math]::Max(0.001, ($at - $previousAt).TotalSeconds)
    $sample = [pscustomobject]@{
        Utc = $at.ToString('o')
        RootProcessId = $rootId
        Scope = $PSCmdlet.ParameterSetName
        ProcessCount = $count
        PrivateMB = [Math]::Round($privateBytes / 1MB, 2)
        WorkingSetMB = [Math]::Round($workingBytes / 1MB, 2)
        CpuPercentOfMachine = [Math]::Round(100 * $cpuDelta / $elapsed / [Environment]::ProcessorCount, 3)
        Handles = $handles
    }
    $sample | Export-Csv -LiteralPath $output -NoTypeInformation -Append
    $peakPrivate = [Math]::Max($peakPrivate, $sample.PrivateMB)
    $peakWorkingSet = [Math]::Max($peakWorkingSet, $sample.WorkingSetMB)
    $previousAt = $at; $rows++
    Start-Sleep -Seconds $IntervalSeconds
}
Write-Host "Saved $rows samples. Observed peak: $peakPrivate MB private; $peakWorkingSet MB summed working set. No forced GC or memory trimming."
