// Runs every tests/*.test.js file: `node tests/run.js`
const fs = require('fs');
const path = require('path');
const { runRegisteredTests, state } = require('./helpers');

fs.readdirSync(__dirname)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .forEach((file) => {
    state.currentFile = file;
    require(path.join(__dirname, file));
  });

runRegisteredTests().then((failures) => process.exit(failures ? 1 : 0));
