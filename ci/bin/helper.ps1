#Set-StrictMode -Version Latest
#$ErrorActionPreference = "Stop"
#$PSDefaultParameterValues['*:ErrorAction'] = "Stop"
function ThrowOnNativeFailure {
  if (-not $?) {
    throw 'Native Failure'
  }
}

function psenvsubstr($data) {
  foreach($v in Get-ChildItem env:) {
    $key = '${' + $v.Name + '}'
    $data = $data.Replace($key, $v.Value)
  }
  return $data
}