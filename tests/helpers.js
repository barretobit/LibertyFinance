// Tiny test helpers: no dependencies, plain node. Run all tests with `node tests/run.js`.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repositoryRoot = path.join(__dirname, '..');

// The app's scripts are plain browser scripts that declare globals. This loads
// some of them into one shared scope (with optional fake globals such as
// `window` or `Storage`) and returns the names asked for.
function loadScripts(files, exportedNames, fakeGlobals = {}) {
  const source = files.map((file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).join('\n;\n');
  const globalNames = Object.keys(fakeGlobals);
  const factory = new Function(...globalNames, source + '\nreturn { ' + exportedNames.join(', ') + ' };');
  return factory(...globalNames.map((name) => fakeGlobals[name]));
}

function assertNear(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-6, (label || 'value') + ': expected ' + expected + ', got ' + actual);
}

const registeredTests = [];
const state = { currentFile: '' };

function test(name, run) {
  registeredTests.push({ file: state.currentFile, name, run });
}

async function runRegisteredTests() {
  let failures = 0;
  let printedFile = null;
  for (const { file, name, run } of registeredTests) {
    if (file !== printedFile) {
      console.log(file);
      printedFile = file;
    }
    try {
      await run();
      console.log('  ok    ' + name);
    } catch (error) {
      failures++;
      console.log('  FAIL  ' + name + '\n        ' + (error && error.message));
    }
  }
  console.log('\n' + (registeredTests.length - failures) + ' passed, ' + failures + ' failed');
  return failures;
}

module.exports = { loadScripts, assertNear, test, runRegisteredTests, assert, state };
