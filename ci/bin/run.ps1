# https://stackoverflow.com/questions/2095088/error-when-calling-3rd-party-executable-from-powershell-when-using-an-ide
# 
# Examples:
#
# $mypath = $MyInvocation.MyCommand.Path
# Get-ChildItem env:\
# Get-Job | Where-Object -Property State -eq “Running”
# Get-Location (like pwd)
# if ($null -eq $env:FOO) { $env:FOO = 'bar' }

. "${PSScriptRoot}\helper.ps1"

Set-PSDebug -Trace 2

Write-Output "current user"
whoami
Write-Output "current working directory"
(Get-Location).Path
Write-Output "current PATH"
$Env:PATH

function Job-Cleanup() {
  Get-Job | Stop-Job
  Get-Job | Remove-Job
}

# start clean
Job-Cleanup

# install from artifacts
if ((Test-Path "node_modules-windows-amd64.tar.gz") -and !(Test-Path "node_modules")) {
  Write-Output "extracting node_modules-windows-amd64.tar.gz"
  tar -zxf node_modules-windows-amd64.tar.gz
}

# setup env
$env:PWD = (Get-Location).Path
$env:CI_BUILD_KEY = ([guid]::NewGuid() -Split "-")[0]
$env:CSI_ENDPOINT = $env:TEMP + "\csi-sanity-" + $env:CI_BUILD_KEY + ".sock"
$env:NPIPE_ENDPOINT = "//./pipe/csi-sanity-" + $env:CI_BUILD_KEY + "csi.sock"

# testing values
if (Test-Path "${PSScriptRoot}\run-dev.ps1") {
  . "${PSScriptRoot}\run-dev.ps1"
}

# launch server
$server_job = Start-Job -FilePath .\ci\bin\launch-server.ps1 -InitializationScript {} -ArgumentList $PSScriptRoot

# launch csi-grpc-proxy
$csi_grpc_proxy_job = Start-Job -FilePath .\ci\bin\launch-csi-grpc-proxy.ps1 -InitializationScript {} -ArgumentList $PSScriptRoot

# wait for socket to appear
$iter = 0
$max_iter = 60
$started = 1
while (!(Test-Path "${env:CSI_ENDPOINT}")) {
  $iter++
  Write-Output "Waiting for ${env:CSI_ENDPOINT} to appear"
  Start-Sleep 1
  Get-Job | Receive-Job
  if ($iter -gt $max_iter) {
    Write-Output "${env:CSI_ENDPOINT} failed to appear"
    $started = 0
    break
  }
}

# launch csi-sanity
if ($started -eq 1) {
  $csi_sanity_job = Start-Job -FilePath .\ci\bin\launch-csi-sanity.ps1 -InitializationScript {} -ArgumentList $PSScriptRoot
}

# https://docs.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-job?view=powershell-7.2
# -ChildJobState
$iter = 0
while ($csi_sanity_job -and ($csi_sanity_job.State -eq "Running" -or $csi_sanity_job.State -eq "NotStarted")) {
  $iter++
  foreach ($job in Get-Job) {
    if (($job -eq $csi_grpc_proxy_job) -and ($iter -gt 20)) {
      continue
    }
    try {
      $job | Receive-Job
    }
    catch {
      if ($job.State -ne "Failed") {
        Write-Output "failure receiving job data"
        $job | ConvertTo-Json | Write-Output
        Write-Output $_
        throw $_
      }
    }
  }
}

# spew any remaining job output to the console
foreach ($job in Get-Job) {
  if ($job -eq $csi_grpc_proxy_job) {
    continue
  }
  try {
    $job | Receive-Job
  }
  catch {}
}

# wait for good measure
if ($csi_sanity_job) {
  Wait-Job -Job $csi_sanity_job
}

#Get-Job | fl

$exit_code = 0

if (! $csi_sanity_job) {
  $exit_code = 1
}

if ($csi_sanity_job -and $csi_sanity_job.State -eq "Failed") {
  $exit_code = 1
}

# cleanup after ourselves
Job-Cleanup
Exit $exit_code
