if (! $PSScriptRoot) {
  $PSScriptRoot = $args[0]
}

. "${PSScriptRoot}\helper.ps1"

Set-Location $env:PWD
Write-Output "launching server"

$env:LOG_LEVEL = "debug"
$env:CSI_VERSION = "1.9.0"
$env:CSI_NAME = "driver-test"
$env:CSI_SANITY = "1"

if (! ${env:CONFIG_FILE}) {
  $env:CONFIG_FILE = $env:TEMP + "\csi-config-" + $env:CI_BUILD_KEY + ".yaml"
  if ($env:TEMPLATE_CONFIG_FILE) {
    $config_data = Get-Content "${env:TEMPLATE_CONFIG_FILE}" -Raw
    $config_data = psenvsubstr($config_data)
    $config_data | Set-Content "${env:CONFIG_FILE}"
  }
}

node "${PSScriptRoot}\..\..\bin\democratic-csi" `
  --log-level "$env:LOG_LEVEL" `
  --driver-config-file "$env:CONFIG_FILE" `
  --csi-version "$env:CSI_VERSION" `
  --csi-name "$env:CSI_NAME" `
  --server-socket "${env:NPIPE_ENDPOINT}" 2>&1 | % { "$_" }
