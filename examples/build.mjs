#!/usr/bin/env node
// Seals the hand-written example bundle IN PLACE so the committed exploded
// directory is itself a conformant bundle: canonicalizes every NDJSON line and
// schema file, sorts records by $id, fills manifest recordCounts/sha256s and
// blob totals, and rewrites checksums.sha256. Run after editing any example
// file:  node examples/build.mjs [dir]

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256 } from '../src/ember.mjs';

const root = process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', 'acme-mini');

const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(relative(root, full).split(sep).join('/'));
    }
    return out;
};

const canonNdjson = (path) => {
    const full = join(root, path);
    const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((l) => JSON.parse(l));
    records.sort((a, b) => (a.$id < b.$id ? -1 : a.$id > b.$id ? 1 : 0));
    writeFileSync(full, records.map((r) => canonicalize(r) + '\n').join(''));
    return records.length;
};

const all = walk(root);
for (const path of all) {
    if (path.endsWith('.ndjson')) canonNdjson(path);
    if (path.startsWith('schema/') && path.endsWith('.json')) {
        const full = join(root, path);
        writeFileSync(full, canonicalize(JSON.parse(readFileSync(full, 'utf8'))) + '\n');
    }
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
for (const r of manifest.resources) {
    const buf = readFileSync(join(root, r.file));
    r.recordCount = buf.length === 0 ? 0 : buf.toString('utf8').trimEnd().split('\n').length;
    r.sha256 = sha256(buf);
}
if (manifest.blobs) {
    const blobs = walk(root).filter((p) => p.startsWith('blobs/sha256/'));
    manifest.blobs.count = blobs.length;
    manifest.blobs.bytes = blobs.reduce((a, p) => a + statSync(join(root, p)).size, 0);
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const sums = walk(root)
    .filter((p) => p !== 'checksums.sha256' && p !== 'manifest.sig')
    .sort()
    .map((p) => `${sha256(readFileSync(join(root, p)))}  ${p}`)
    .join('\n') + '\n';
writeFileSync(join(root, 'checksums.sha256'), sums);

console.log(`sealed ${root} — bundleDigest sha256:${sha256(Buffer.from(sums))}`);
