#!/usr/bin/env node

// Tests for the /collage static mount (collage_ui.js) — the built React app
// must be served with a trailing-slash redirect (relative asset URLs depend
// on it), and an unbuilt dist must fail loud, not 404 silently.

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const express = require('express');

const { mountCollageUi } = require('../collage_ui');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function withServer(distPath, fn) {
  const app = express();
  mountCollageUi(app, distPath);
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function makeDist() {
  const dist = path.join(os.tmpdir(), `collage-ui-dist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Collage Builder</title>');
  await fs.writeFile(path.join(dist, 'assets', 'index-abc.js'), 'console.log("collage")');
  return dist;
}

test('GET /collage redirects with a RELATIVE location so the ingress prefix survives', async () => {
  const dist = await makeDist();
  try {
    await withServer(dist, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/collage?ids=a.jpg,b.jpg`, { redirect: 'manual' });
      assert.strictEqual(res.status, 301);
      const location = res.headers.get('location');
      // An absolute path (/collage/) would resolve against the ingress host
      // root and lose the /api/hassio_ingress/<token> prefix. It must be
      // relative, and must keep the query string.
      assert.strictEqual(location, 'collage/?ids=a.jpg,b.jpg');
    });
  } finally {
    await fs.rm(dist, { recursive: true, force: true });
  }
});

test('GET /collage/ serves the built index.html', async () => {
  const dist = await makeDist();
  try {
    await withServer(dist, async (baseUrl) => {
      // redirect: 'manual' so a bogus /collage/ -> /collage/collage/ redirect
      // can't be silently followed into the index.html fallback
      const res = await fetch(`${baseUrl}/collage/?ids=a.jpg,b.jpg`, { redirect: 'manual' });
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('Collage Builder'));
    });
  } finally {
    await fs.rm(dist, { recursive: true, force: true });
  }
});

test('GET /collage/assets/* serves hashed assets', async () => {
  const dist = await makeDist();
  try {
    await withServer(dist, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/collage/assets/index-abc.js`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('collage'));
    });
  } finally {
    await fs.rm(dist, { recursive: true, force: true });
  }
});

test('missing dist responds 503 with a build hint, not a bare 404', async () => {
  const dist = path.join(os.tmpdir(), `collage-ui-missing-${Date.now()}`);
  await withServer(dist, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/collage/`);
    assert.strictEqual(res.status, 503);
    const body = await res.text();
    assert.ok(/build/i.test(body), 'body should tell the operator to build the UI');
  });
});

async function run() {
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`${colors.green}✓${colors.reset} ${name}`);
      passed++;
    } catch (error) {
      console.log(`${colors.red}✗${colors.reset} ${name}`);
      console.log(`  ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  // Let the process exit naturally — process.exit() while undici's
  // keep-alive sockets are mid-teardown triggers a libuv assert on Windows.
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
