# One line per 3D-engine counter instance of the Windows GPU counters: instance name, percent, process name (tab separated).
# Read by parseEngineUse in bench-log.ts. The rate counters need two samples, so this takes two and keeps the second.
$ErrorActionPreference = 'Stop'
$samples = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -SampleInterval 1 -MaxSamples 2
foreach ($sample in $samples[-1].CounterSamples) {
  $name = ''
  if ($sample.InstanceName -match '^pid_(\d+)_') {
    $process = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
    if ($process) { $name = $process.ProcessName }
  }
  "$($sample.InstanceName)`t$($sample.CookedValue)`t$name"
}
