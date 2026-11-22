const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

test('deferred snapshot is fetched again after pending writes settle', async () => {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    clear: () => storage.clear(),
    key: index => Array.from(storage.keys())[index] ?? null
  };
  const window = {localStorage, location: {hostname: 'example', origin: 'http://example'}};
  let releaseWrite;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  const getHeaders = [];
  const fetch = async (_url, options) => {
    if (options.method === 'POST') {
      await pendingWrite;
      return {ok: true, status: 200, headers: {get: () => ''}, json: async () => ({ok: true})};
    }
    getHeaders.push({...options.headers});
    return {
      ok: true, status: 200, headers: {get: () => '"snapshot"'},
      json: async () => ({pd_projects: JSON.stringify([{id: 'p1', title: 'Saved'}])})
    };
  };
  let source = fs.readFileSync(path.join(__dirname, '../data.js'), 'utf8');
  source = source.replace('window.DataLayer.ready = runStartupHydration();',
    'window.DataLayer.testSnapshot = loadRemoteSnapshot; window.DataLayer.ready = Promise.resolve();');
  source = source.replace(/runStartupHydration\(\)\.finally\(function \(\) \{\s*startRemoteSyncLoop\(\);\s*startRemoteKvStream\(\);\s*\}\);/, '');
  vm.runInNewContext(source, {window, fetch, console, URL, Promise});
  const data = window.DataLayer;

  data.setStoredValue('pd_example', 'pending');
  const first = await data.testSnapshot();
  assert.equal(first.deferred, true);
  let settled = false;
  const writes = data.waitForStorageWrites().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseWrite();
  await writes;
  await data.refreshFromRemote();
  assert.equal(getHeaders.length, 2);
  assert.equal(getHeaders[1]['If-None-Match'], undefined);
  assert.equal(data.getProjects()[0].title, 'Saved');
});
