const { installPackages } = require('../utils');

async function run() {
  installPackages({ apt: ['nfs-common'], yum: ['nfs-utils'] });
}

module.exports = { run };
