if (! $PSScriptRoot) {
  $PSScriptRoot = $args[0]
}

. "${PSScriptRoot}\helper.ps1"

Set-Location $env:PWD

Write-Output "launching csi-grpc-proxy"

$env:PROXY_TO = "npipe://" + $env:NPIPE_ENDPOINT
$env:BIND_TO = "unix://" + $env:CSI_ENDPOINT

# https://stackoverflow.com/questions/2095088/error-when-calling-3rd-party-executable-from-powershell-when-using-an-ide
csi-grpc-proxy.exe 2>&1 | % { "$_" }
