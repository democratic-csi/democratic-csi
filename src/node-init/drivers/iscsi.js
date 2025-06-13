const { installPackages, enableService, startService, runCommand, commandExists } = require('../utils');
const fs = require('fs');

async function run() {
  installPackages({
    apt: ['open-iscsi','lsscsi','sg3-utils','multipath-tools','scsitools'],
    yum: ['lsscsi','iscsi-initiator-utils','sg3_utils','device-mapper-multipath']
  });

  if (!fs.existsSync('/etc/multipath.conf')) {
    // configuration may be needed but is skipped if file is absent
  }

  if (commandExists('mpathconf')) {
    try {
      runCommand('mpathconf', ['--enable','--with_multipathd','y']);
    } catch (e) {}
  }

  ;['iscsid','multipathd','iscsi','open-iscsi'].forEach(s => {
    enableService(s);
    startService(s);
  });
}

module.exports = { run };
