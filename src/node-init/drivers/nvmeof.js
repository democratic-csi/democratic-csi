const { installPackages, loadModule } = require('../utils');
const fs = require('fs');

async function run() {
  installPackages({ apt: ['nvme-cli','linux-generic'], yum: ['nvme-cli'] });

  const config = '/etc/modules-load.d/nvme.conf';
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, 'nvme\nnvme-tcp\nnvme-fc\nnvme-rdma\n');
  }

  ['nvme','nvme-tcp','nvme-fc','nvme-rdma'].forEach(loadModule);
}

module.exports = { run };
