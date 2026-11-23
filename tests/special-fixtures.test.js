// HTTP-level checks for the three local-only special fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { request } from './helpers.js';
import { SPECIAL, startHarnessServer, startFailingGateway, findClosedPort } from './harness/special-fixtures.js';
import { LANES } from '../functions/generated/data.js';
import { loadConfig } from '../configuration/config.js';
import { localEnv } from './harness/suite.js';

test('Google rate-limit fixture: 429 + expected text, served locally', async () => {
  const { server, port } = await startHarnessServer();
  try {
    const r = await request({ port, host: SPECIAL.harnessHost, path: `${SPECIAL.googleRateLimit.localPath}?continue=x&q=y` });
    assert.equal(r.status, 429);
    assert.ok(r.body.includes(SPECIAL.googleRateLimit.text));
    assert.ok(new URL(SPECIAL.googleRateLimit.virtualUrl).pathname.startsWith('/sorry/'));
  } finally { server.close(); }
});

test('YouTube account-gate fixture: expected neutral content, served locally', async () => {
  const { server, port } = await startHarnessServer();
  try {
    const r = await request({ port, host: SPECIAL.harnessHost, path: SPECIAL.youtubeGate.localPath });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(SPECIAL.youtubeGate.text.replace("'", '&#39;')));
  } finally { server.close(); }
});

test('harness refuses other hosts', async () => {
  const { server, port } = await startHarnessServer();
  try {
    assert.equal((await request({ port, host: 'northstar-control.localhost', path: SPECIAL.googleRateLimit.localPath })).status, 421);
  } finally { server.close(); }
});

test('proxy gateway fixture: CONNECT and plain requests get 502; closed port refuses', async () => {
  const { server, port } = await startFailingGateway();
  try {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT northstar-proxy-probe.invalid:443 HTTP/1.1\r\nHost: northstar-proxy-probe.invalid:443\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => { buf += d; });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 502/);
    const plain = await request({ port, host: 'northstar-proxy-probe.invalid', path: '/' });
    assert.equal(plain.status, 502);
  } finally { server.close(); }
  const closed = await findClosedPort();
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect(closed, '127.0.0.1', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  }));
});

test('special fixtures are not reachable through any of the 12 public lanes', () => {
  const c = loadConfig(localEnv(), LANES);
  assert.equal(c.hostToLane.has(SPECIAL.harnessHost), false);
  for (const host of c.hostToLane.keys()) assert.ok(!/google|youtube|proxy|harness/.test(host));
});
