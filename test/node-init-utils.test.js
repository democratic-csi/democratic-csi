const test = require('node:test');
const assert = require('node:assert');

function loadUtils(mockSpawn, mockExists) {
  const cp = require('child_process');
  const fs = require('fs');
  cp.spawnSync = mockSpawn;
  if (mockExists) fs.existsSync = mockExists;
  delete require.cache[require.resolve('../src/node-init/utils')];
  return require('../src/node-init/utils');
}

test('commandExists true', () => {
  const calls = [];
  const utils = loadUtils((...args) => { calls.push(args); return {status:0}; });
  assert.strictEqual(utils.commandExists('ls'), true);
  assert.deepStrictEqual(calls[0], ['which', ['ls']]);
});

test('commandExists false', () => {
  const utils = loadUtils(() => ({status:1}));
  assert.strictEqual(utils.commandExists('ls'), false);
});

test('runCommand success', () => {
  const calls = [];
  const utils = loadUtils((...args) => { calls.push(args); return {status:0}; });
  assert.doesNotThrow(() => utils.runCommand('cmd', ['arg']));
  assert.deepStrictEqual(calls[0], ['cmd', ['arg'], {stdio:'inherit'}]);
});

test('runCommand failure', () => {
  const utils = loadUtils(() => ({status:1}));
  assert.throws(() => utils.runCommand('cmd', []));
});

test('installPackages apt missing', () => {
  const calls = [];
  const responses = [
    {status:0}, // which apt-get
    {status:1}, // dpkg -s
    {status:0}, // apt-get install
  ];
  const mock = (...args) => { calls.push(args); return responses.shift(); };
  const utils = loadUtils(mock);
  utils.installPackages({apt:['pkg']});
  assert.deepStrictEqual(calls[2], ['apt-get', ['install','-y','pkg'], {stdio:'inherit'}]);
});

test('installPackages apt installed', () => {
  const calls = [];
  const responses = [
    {status:0}, // which apt-get
    {status:0}, // dpkg -s (installed)
  ];
  const mock = (...args) => { calls.push(args); return responses.shift(); };
  const utils = loadUtils(mock);
  utils.installPackages({apt:['pkg']});
  assert.strictEqual(calls.length, 2); // no install call
});

test('installPackages yum missing', () => {
  const calls = [];
  const responses = [
    {status:1}, // which apt-get
    {status:0}, // which yum
    {status:1}, // rpm -q
    {status:0}, // yum install
  ];
  const mock = (...args) => { calls.push(args); return responses.shift(); };
  const utils = loadUtils(mock);
  utils.installPackages({yum:['pkg']});
  assert.deepStrictEqual(calls[3], ['yum', ['install','-y','pkg'], {stdio:'inherit'}]);
});
