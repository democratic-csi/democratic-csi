if (! $PSScriptRoot) {
  $PSScriptRoot = $args[0]
}

. "${PSScriptRoot}\helper.ps1"

Set-Location $env:PWD

$exit_code = 0
$tmpdir = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ([System.IO.Path]::GetRandomFileName())
$env:CSI_SANITY_TEMP_DIR = $tmpdir.FullName

# cleanse endpoint to something csi-sanity plays nicely with
$endpoint = ${env:CSI_ENDPOINT}
$endpoint = $endpoint.replace("C:\", "/")
$endpoint = $endpoint.replace("\", "/")

if (! $env:CSI_SANITY_FAILFAST) {
  $env:CSI_SANITY_FAILFAST = "false"
}

$failfast = ""

if ($env:CSI_SANITY_FAILFAST -eq "true") {
  $failfast = "-ginkgo.failFast"
}

Write-Output "launching csi-sanity"
Write-Output "connecting to: ${endpoint}"
Write-Output "failfast: ${env:CSI_SANITY_FAILFAST}"
Write-Output "skip: ${env:CSI_SANITY_SKIP}"
Write-Output "focus: ${env:CSI_SANITY_FOCUS}"
Write-Output "csi.mountdir: ${env:CSI_SANITY_TEMP_DIR}\mnt"
Write-Output "csi.stagingdir: ${env:CSI_SANITY_TEMP_DIR}\stage"

$skip = '"' + ${env:CSI_SANITY_SKIP} + '"'
$focus = '"' + ${env:CSI_SANITY_FOCUS} + '"'

csi-sanity.exe -"csi.endpoint" "unix://${endpoint}" `
  $failfast `
  -"csi.mountdir" "${env:CSI_SANITY_TEMP_DIR}\mnt" `
  -"csi.stagingdir" "${env:CSI_SANITY_TEMP_DIR}\stage" `
  -"csi.testvolumeexpandsize" 2147483648 `
  -"csi.testvolumesize" 1073741824 `
  -"ginkgo.skip" $skip `
  -"ginkgo.focus" $focus

# does not work the same as linux for some reason
# -"ginkgo.skip" "'" + ${env:CSI_SANITY_SKIP} + "'" `

if (-not $?) {
  $exit_code = $LASTEXITCODE
  Write-Output "csi-sanity exit code: ${exit_code}"
  if ($exit_code -gt 0) {
    $exit_code = 1
  }
}

# remove tmp dir
Remove-Item -Path "$env:CSI_SANITY_TEMP_DIR" -Force -Recurse

#Exit $exit_code
Write-Output "exiting with exit code: ${exit_code}"

if ($exit_code -gt 0) {
  throw "csi-sanity failed"
}

# these do not work for whatever reason
#Exit $exit_code
#[System.Environment]::Exit($exit_code)
