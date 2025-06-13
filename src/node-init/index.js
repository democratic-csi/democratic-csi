const fs = require('fs');
const path = require('path');

async function run(drivers) {
  for (const name of drivers) {
    const file = path.join(__dirname, 'drivers', `${name}.js`);
    if (!fs.existsSync(file)) {
      console.log(`no node init script for driver: ${name}`);
      continue;
    }
    const mod = require(file);
    try {
      if (typeof mod.run === 'function') {
        await mod.run();
      }
    } catch (e) {
      console.error(`driver ${name} failed: ${e.toString()}`);
    }
  }
}

module.exports = { run };
