write-host "starting democratic-csi via entrypoint.ps1"
$env:Path = "${pwd}\bin;${env:Path}"

.\bin\node.exe --expose-gc .\bin\democratic-csi @args

Exit $LASTEXITCODE
