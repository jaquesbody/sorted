#!/usr/bin/env node
/*
 * Sorted sync host.
 *
 * Serves one file — the snapshot — over the local network. That is the whole
 * job. There is no database here, no accounts, no history: the newest snapshot
 * is the truth, and Sorted on either end decides for itself whether to push or
 * pull.
 *
 * Deliberately not a framework. The whole surface is two verbs, and a
 * dependency-free script is something you can leave running on a machine in a
 * cupboard without wondering what it is phoning home to.
 *
 *   node tools/sync-host.mjs --dir ~/sorted-sync --port 8787
 *
 * Binds to all interfaces so a phone on the same Wi-Fi can reach it. It serves
 * nothing else, so the exposure is exactly one file. If that still makes you
 * uneasy, --host 127.0.0.1 plus an SSH tunnel works just as well.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DIR = resolve(flag('dir', join(tmpdir(), 'sorted-sync')));
const PORT = Number(flag('port', '8787'));
const BIND = flag('host', '0.0.0.0');
const FILE = join(DIR, 'sorted-snapshot.json');

if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });

// Sorted sends the whole snapshot in one PUT and expects a 2xx. It never
// sends credentials and never sends anything else, so there is no auth to
// check — but an open PUT on a shared network is an open PUT, so the file is
// only ever replaced whole and never appended to.
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    // The phone is a different origin from this host. Without these the
    // WebView's preflight fails and the sync never leaves the device.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (path === '/health') {
    let has = false;
    try { await readFile(FILE, 'utf8'); has = true; } catch (err) { has = false; }
    return send(res, 200, JSON.stringify({ ok: true, snapshot: has, dir: DIR }));
  }

  if (path !== '/sorted-snapshot.json') {
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  }

  if (req.method === 'GET') {
    let text;
    try {
      text = await readFile(FILE, 'utf8');
    } catch (err) {
      // No snapshot yet is a normal first-run answer, not an error: Sorted reads
      // 404 as "nothing there" and pushes.
      return send(res, 404, JSON.stringify({ error: 'no snapshot yet' }));
    }
    return send(res, 200, text);
  }

  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      // A snapshot with receipts in it can be large, but it is not unbounded.
      // 64MB is far past any real one and stops a runaway body filling the disk.
      if (size > 64 * 1024 * 1024) {
        return send(res, 413, JSON.stringify({ error: 'too large' }));
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { JSON.parse(text); } catch (err) {
      return send(res, 400, JSON.stringify({ error: 'not json' }));
    }
    // Write to a temporary file and rename over the target, so a phone that
    // drops off the Wi-Fi mid-upload cannot leave a half-written snapshot that
    // both devices then try to parse.
    const tmp = FILE + '.tmp';
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, FILE);
    const when = (JSON.parse(text).updatedAt) || '';
    console.log(`${new Date().toISOString()}  PUT  ${size} bytes  ${when}`);
    return send(res, 200, JSON.stringify({ ok: true, bytes: size }));
  }

  return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
});

server.listen(PORT, BIND, () => {
  const addrs = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log(`Sorted sync host`);
  console.log(`  serving  ${FILE}`);
  console.log(`  on port  ${PORT}`);
  console.log(`  address  ${addrs.length ? addrs.join(', ') : BIND}`);
  console.log('');
  console.log('  In Sorted, Settings → Sync, use:');
  for (const a of addrs) console.log(`    http://${a}:${PORT}/sorted-snapshot.json`);
  console.log('');
  console.log('  Leave this running. Ctrl-C to stop.');
});
