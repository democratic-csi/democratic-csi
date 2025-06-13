const { spawnSync } = require('child_process');
const fs = require('fs');

function commandExists(cmd) {
  const res = spawnSync('which', [cmd]);
  return res.status === 0;
}

function runCommand(cmd, args) {
  console.log(`executing: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
}

function installPackages(pkgs) {
  if (!pkgs) return;
  if (commandExists('apt-get')) {
    (pkgs.apt || []).forEach((p) => {
      if (spawnSync('dpkg', ['-s', p], { stdio: 'ignore' }).status !== 0) {
        runCommand('apt-get', ['install', '-y', p]);
      }
    });
  } else if (commandExists('yum')) {
    (pkgs.yum || []).forEach((p) => {
      if (spawnSync('rpm', ['-q', p], { stdio: 'ignore' }).status !== 0) {
        runCommand('yum', ['install', '-y', p]);
      }
    });
  } else {
    console.log('no supported package manager found');
  }
}

function enableService(name) {
  if (commandExists('systemctl')) {
    if (spawnSync('systemctl', ['is-enabled', name], { stdio: 'ignore' }).status !== 0) {
      runCommand('systemctl', ['enable', name]);
    }
  }
}

function startService(name) {
  if (commandExists('systemctl')) {
    if (spawnSync('systemctl', ['is-active', name], { stdio: 'ignore' }).status !== 0) {
      runCommand('systemctl', ['start', name]);
    }
  }
}

function loadModule(name) {
  if (!fs.existsSync(`/sys/module/${name}`)) {
    if (commandExists('modprobe')) {
      runCommand('modprobe', [name]);
    }
  }
}

module.exports = { commandExists, runCommand, installPackages, enableService, startService, loadModule };
