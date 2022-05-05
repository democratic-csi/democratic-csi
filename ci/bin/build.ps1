Write-Output "current user"
whoami
Write-Output "current working directory"
(Get-Location).Path
Write-Output "current PATH"
$Env:PATH

Write-Output "node version"
node --version
Write-Output "npm version"
npm --version

# install deps
Write-Output "running npm i"
npm i

Write-Output "creating tar.gz"
# tar node_modules to keep the number of files low to upload
tar -zcf node_modules-windows-amd64.tar.gz node_modules
