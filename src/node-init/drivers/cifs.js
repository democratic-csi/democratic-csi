const { installPackages } = require('../utils');

async function run() {
  installPackages({ apt: ['cifs-utils'], yum: ['cifs-utils'] });
}

module.exports = { run };
