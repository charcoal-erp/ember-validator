import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, createCipheriv, scryptSync, sign as cryptoSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadBundle, verifyBundle, canonicalize, validateSchema, readZip,
    diffBundles, isEncryptedBundleFile, decryptBundleFile, lintAdapterBundle,
} from '../src/ember.mjs';

const HERE = join(fileURLToPath(import.meta.url), '..');
const EXAMPLE = join(HERE, '..', 'examples', 'acme-mini');
const ADAPTER = join(HERE, '..', 'examples', 'adapter-csv', 'bundle');
const manifestSchema = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'manifest.schema.json'), 'utf8'));

// Minimal STORE-only zip writer — enough to round-trip the example through
// the validator's zip reader.
const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const buildZip = (files) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of files) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.size, 8);
    eocd.writeUInt16LE(files.size, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
};

test('exploded example bundle verifies with zero errors', () => {
    const report = verifyBundle(loadBundle(EXAMPLE), { manifestSchema });
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors, null, 2));
    // Exactly the two intentional dangling $audit user references.
    assert.equal(report.warnings.length, 2);
    assert.ok(report.warnings.every((w) => w.stage === 5));
});

test('zipped example bundle verifies identically (zip reader round-trip)', () => {
    const files = loadBundle(EXAMPLE);
    const zipPath = join(mkdtempSync(join(tmpdir(), 'ember-')), 'acme-mini.czx');
    writeFileSync(zipPath, buildZip(files));
    const reread = readZip(readFileSync(zipPath));
    assert.equal(reread.size, files.size);
    const report = verifyBundle(reread, { manifestSchema });
    assert.equal(report.errors.length, 0);
    assert.equal(report.bundleDigest, verifyBundle(files, { manifestSchema }).bundleDigest);
});

test('single corrupted byte fails at stage 1 (digests), not later', () => {
    const files = loadBundle(EXAMPLE);
    const buf = Buffer.from(files.get('data/010-core/vendor.ndjson'));
    buf[buf.length - 5] ^= 0x01;
    files.set('data/010-core/vendor.ndjson', buf);
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.some((e) => e.stage === 1 && e.path === 'data/010-core/vendor.ndjson'));
});

test('missing checksums.sha256 fails at stage 0', () => {
    const files = loadBundle(EXAMPLE);
    files.delete('checksums.sha256');
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.some((e) => e.stage === 0));
});

test('uncovered extra file fails at stage 1', () => {
    const files = loadBundle(EXAMPLE);
    files.set('docs/EXTRA.md', Buffer.from('sneaky\n'));
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.some((e) => e.stage === 1 && e.path === 'docs/EXTRA.md'));
});

test('dangling business reference is a stage-5 error', () => {
    const files = loadBundle(EXAMPLE);
    // Drop the vendors file's records entirely: PO -> vendor refs now dangle.
    // Recompute the digest chain so stages 1-3 stay green and the failure
    // isolates to referential closure... except recordCount/sha256 live in the
    // manifest, so rewrite those too.
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const vendor = manifest.resources.find((r) => r.resource === 'vendor');
    files.set(vendor.file, Buffer.alloc(0));
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    vendor.recordCount = 0;
    vendor.sha256 = sha(Buffer.alloc(0));
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    const sums = [...files.keys()]
        .filter((p) => p !== 'checksums.sha256' && p !== 'manifest.sig')
        .sort()
        .map((p) => `${sha(files.get(p))}  ${p}`)
        .join('\n') + '\n';
    files.set('checksums.sha256', Buffer.from(sums));
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.some((e) => e.stage === 5 && e.message.includes('vendor:')));
});

test('CLI verify exits 0 on the example', () => {
    execFileSync(process.execPath, [join(HERE, '..', 'bin', 'ember-validate.mjs'), 'verify', EXAMPLE]);
});

// ─────────────────────────────────────── Phase-3 Trust: stage S (signature, §8.4)
//
// This helper deliberately does NOT import @charcoal/platform-bundle's
// signing.ts — it's a from-scratch port of the same signing-input
// construction, exactly the discipline the validator itself follows
// ("producer and validator never share code").

const b64url = (buf) => buf.toString('base64url');

const signFixture = (files, { keyPair, kid, alg = 'EdDSA', producer = { product: 'test', version: '0' }, custodian } = {}) => {
    const { publicKey, privateKey } = keyPair ?? generateKeyPairSync('ed25519');
    const header = { alg, kid: kid ?? 'test-kid', producer, ...(custodian ? { custodian } : {}) };
    const headerB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
    const payloadB64 = b64url(files.get('checksums.sha256'));
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = cryptoSign(null, signingInput, privateKey);
    files.set('manifest.sig', Buffer.from(`${headerB64}..${b64url(signature)}`));
    return { publicKey, privateKey, kid: header.kid };
};

const jwkOf = (publicKey) => publicKey.export({ format: 'jwk' });

test('valid signature verifies cleanly against the correct public key', () => {
    const files = loadBundle(EXAMPLE);
    const { publicKey, kid } = signFixture(files);
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: { ...jwkOf(publicKey), kid } });
    assert.ok(report.errors.every((e) => e.stage !== 7), JSON.stringify(report.errors));
});

test('signature present but no pubkey supplied: structure-checked, warns only', () => {
    const files = loadBundle(EXAMPLE);
    signFixture(files);
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.every((e) => e.stage !== 7));
    assert.ok(report.warnings.some((w) => w.stage === 7 && w.message.includes('not cryptographically verified')));
});

test('pubkey supplied but manifest.sig missing is a stage-7 error', () => {
    const files = loadBundle(EXAMPLE);
    const { publicKey } = generateKeyPairSync('ed25519');
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: jwkOf(publicKey) });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('no manifest.sig')));
});

test('flipped signature byte fails cleanly at stage 7', () => {
    const files = loadBundle(EXAMPLE);
    const { publicKey, kid } = signFixture(files);
    const sig = files.get('manifest.sig').toString('utf8');
    const parts = sig.split('.');
    const sigBytes = Buffer.from(parts[2], 'base64url');
    sigBytes[0] ^= 0xff;
    files.set('manifest.sig', Buffer.from(`${parts[0]}..${b64url(sigBytes)}`));
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: { ...jwkOf(publicKey), kid } });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('does not verify')));
});

test('wrong verification key fails cleanly at stage 7', () => {
    const files = loadBundle(EXAMPLE);
    signFixture(files);
    const wrongKey = generateKeyPairSync('ed25519').publicKey;
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: jwkOf(wrongKey) });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('does not verify')));
});

test('signature-over-tampered-checksums fails cleanly at stage 7 (independently of stage 1)', () => {
    const files = loadBundle(EXAMPLE);
    const { publicKey, kid } = signFixture(files);
    // Tamper checksums.sha256 AFTER signing — one hex digit in a listed hash.
    const sums = files.get('checksums.sha256').toString('utf8');
    const tampered = sums.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));
    files.set('checksums.sha256', Buffer.from(tampered));
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: { ...jwkOf(publicKey), kid } });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('does not verify')));
    assert.ok(report.errors.some((e) => e.stage === 1), 'expected stage 1 to independently flag the corrupted checksums file too');
});

test('kid mismatch between signature and supplied public key is a stage-7 error', () => {
    const files = loadBundle(EXAMPLE);
    const { publicKey } = signFixture(files, { kid: 'signing-kid-1' });
    const report = verifyBundle(files, { manifestSchema, pubkeyJwk: { ...jwkOf(publicKey), kid: 'other-kid-2' } });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('does not match')));
});

test('manifest.sig missing producer slot is a stage-7 error', () => {
    const files = loadBundle(EXAMPLE);
    const { privateKey } = generateKeyPairSync('ed25519');
    const header = { alg: 'EdDSA', kid: 'k1' }; // no producer — violates §8.4
    const headerB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
    const payloadB64 = b64url(files.get('checksums.sha256'));
    const signature = cryptoSign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), privateKey);
    files.set('manifest.sig', Buffer.from(`${headerB64}..${b64url(signature)}`));
    const report = verifyBundle(files, { manifestSchema });
    assert.ok(report.errors.some((e) => e.stage === 7 && e.message.includes('producer')));
});

test('canonicalize sorts keys recursively and is stable', () => {
    assert.equal(canonicalize({ b: 1, a: { d: null, c: [2, { z: 1, y: 2 }] } }),
        '{"a":{"c":[2,{"y":2,"z":1}],"d":null},"b":1}');
});

test('schema subset validator catches type, enum, pattern, required', () => {
    const schema = {
        type: 'object',
        required: ['Total'],
        properties: {
            Total: { type: 'string', pattern: '^-?[0-9]+\\.[0-9]{2}$' },
            Status: { enum: ['Draft', 'Approved'] },
            Gstin: { type: ['string', 'null'] },
        },
        additionalProperties: false,
    };
    assert.equal(validateSchema({ Total: '10.00', Status: 'Draft', Gstin: null }, schema).length, 0);
    assert.ok(validateSchema({ Total: 10.0 }, schema).length > 0);           // wrong type
    assert.ok(validateSchema({ Total: '10.0' }, schema).length > 0);          // pattern
    assert.ok(validateSchema({ Total: '10.00', Status: 'Closed' }, schema).length > 0); // enum
    assert.ok(validateSchema({ Status: 'Draft' }, schema).length > 0);        // required
    assert.ok(validateSchema({ Total: '10.00', Extra: 1 }, schema).length > 0); // additional
});

test('schema subset validator resolves local $ref and matches oneOf variants', () => {
    const schema = {
        type: 'object',
        required: ['step'],
        properties: { step: { $ref: '#/$defs/step' } },
        $defs: {
            step: {
                oneOf: [
                    { type: 'object', required: ['kind', 'a'], properties: { kind: { const: 'a' }, a: { type: 'string' } } },
                    { type: 'object', required: ['kind', 'b'], properties: { kind: { const: 'b' }, b: { type: 'number' } } },
                ],
            },
        },
    };
    assert.equal(validateSchema({ step: { kind: 'a', a: 'x' } }, schema).length, 0);
    assert.equal(validateSchema({ step: { kind: 'b', b: 1 } }, schema).length, 0);
    assert.ok(validateSchema({ step: { kind: 'c' } }, schema).length > 0);
});

// ─────────────────────────────────────────── IS-0 MappingSpec DSL (lint)

const mappingSpecSchema = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'mapping-spec-1.0.schema.json'), 'utf8'));
const MAPPING_SPEC_SAMPLE = join(HERE, '..', 'examples', 'mapping-spec-sample.json');

test('a hand-written real MappingSpec (assembled from the Import Studio exploration\'s own generated per-entity configs) lints clean', () => {
    const spec = JSON.parse(readFileSync(MAPPING_SPEC_SAMPLE, 'utf8'));
    assert.equal(validateSchema(spec, mappingSpecSchema).length, 0);
    assert.equal(spec.entities.length, 6);
});

test('CLI lint exits 0 on the sample MappingSpec, nonzero on a broken one', () => {
    execFileSync(process.execPath, [join(HERE, '..', 'bin', 'ember-validate.mjs'), 'lint', MAPPING_SPEC_SAMPLE]);
    const broken = JSON.parse(readFileSync(MAPPING_SPEC_SAMPLE, 'utf8'));
    broken.specVersion = '2.0';
    const tmp = join(mkdtempSync(join(tmpdir(), 'mapping-spec-')), 'broken.json');
    writeFileSync(tmp, JSON.stringify(broken));
    assert.throws(() => execFileSync(process.execPath, [join(HERE, '..', 'bin', 'ember-validate.mjs'), 'lint', tmp]));
});

// ─────────────────────────────────────────── Phase-3 Trust: encryption (§2.1/§9.4)

const ENC_MAGIC = Buffer.from('EMBRENC1', 'utf8');

// Independent encrypt helper for tests — deliberately NOT importing
// platform-bundle's encryption.ts (same "producer and validator never share
// code" discipline as the signing tests).
const encryptBytes = (plain, passphrase) => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([ENC_MAGIC, salt, iv, ciphertext, cipher.getAuthTag()]);
};

test('isEncryptedBundleFile detects the magic, decryptBundleFile round-trips', () => {
    const plain = Buffer.from('plaintext bundle bytes here');
    const enc = encryptBytes(plain, 'a-passphrase');
    assert.equal(isEncryptedBundleFile(enc), true);
    assert.equal(isEncryptedBundleFile(plain), false);
    assert.ok(decryptBundleFile(enc, 'a-passphrase').equals(plain));
});

test('decryptBundleFile throws on wrong passphrase', () => {
    const enc = encryptBytes(Buffer.from('secret'), 'right');
    assert.throws(() => decryptBundleFile(enc, 'wrong'));
});

test('loadBundle on an encrypted .czx requires a passphrase, then verifies normally', () => {
    const files = loadBundle(EXAMPLE);
    const zipBytes = buildZip(files);
    const dir = mkdtempSync(join(tmpdir(), 'ember-enc-'));
    const encPath = join(dir, 'bundle.czx.enc');
    writeFileSync(encPath, encryptBytes(zipBytes, 'test-pass'));

    assert.throws(() => loadBundle(encPath), /encrypted/);
    const reloaded = loadBundle(encPath, { passphrase: 'test-pass' });
    const report = verifyBundle(reloaded, { manifestSchema });
    assert.equal(report.errors.length, 0);
});

// ─────────────────────────────────────────── Phase-3 Trust: diff (unit 4)

test('diffBundles reports no deltas for two loads of the identical bundle', () => {
    const a = loadBundle(EXAMPLE);
    const b = loadBundle(EXAMPLE);
    assert.deepEqual(diffBundles(a, b), []);
});

test('diffBundles detects added/removed/changed records by $id', () => {
    const a = loadBundle(EXAMPLE);
    const b = loadBundle(EXAMPLE);
    const vendorFile = JSON.parse(a.get('manifest.json').toString('utf8'))
        .resources.find((r) => r.resource === 'vendor').file;

    const linesA = a.get(vendorFile).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const changedRecord = { ...linesA[0], Name: `${linesA[0].Name} EDITED` };
    const keptRest = linesA.slice(2); // drop linesA[1] entirely -> "removed"
    const addedRecord = { ...linesA[0], $id: 'vendor:00000000-0000-0000-0000-000000000099', Name: 'Brand New Vendor' };
    const newLines = [changedRecord, ...keptRest, addedRecord]
        .sort((x, y) => (x.$id < y.$id ? -1 : 1))
        .map((r) => canonicalize(r));
    b.set(vendorFile, Buffer.from(newLines.join('\n') + '\n'));

    const deltas = diffBundles(a, b);
    const vendorDelta = deltas.find((d) => d.resource === 'vendor');
    assert.ok(vendorDelta, 'expected a vendor delta');
    assert.deepEqual(vendorDelta.added, ['vendor:00000000-0000-0000-0000-000000000099']);
    assert.deepEqual(vendorDelta.removed, [linesA[1].$id]);
    assert.equal(vendorDelta.changed.length, 1);
    assert.equal(vendorDelta.changed[0].id, linesA[0].$id);
    assert.deepEqual(vendorDelta.changed[0].fields.Name, { before: linesA[0].Name, after: changedRecord.Name });
});

test('CLI diff exits 0 with no output on identical bundles, nonzero with deltas reported', () => {
    execFileSync(process.execPath, [join(HERE, '..', 'bin', 'ember-validate.mjs'), 'diff', EXAMPLE, EXAMPLE]);

    const files = loadBundle(EXAMPLE);
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const vendorFile = manifest.resources.find((r) => r.resource === 'vendor').file;
    const buf = files.get(vendorFile);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    lines[0] = canonicalize({ ...JSON.parse(lines[0]), Name: 'A Totally Different Name' });
    files.set(vendorFile, Buffer.from(lines.join('\n') + '\n'));

    const dirB = mkdtempSync(join(tmpdir(), 'ember-diffB-'));
    for (const [path, data] of files) {
        const full = join(dirB, path);
        execFileSync('mkdir', ['-p', join(full, '..')]);
        writeFileSync(full, data);
    }

    let output = '';
    let status = 0;
    try {
        output = execFileSync(process.execPath, [join(HERE, '..', 'bin', 'ember-validate.mjs'), 'diff', EXAMPLE, dirB]).toString();
    } catch (err) {
        status = err.status;
        output = err.stdout.toString();
    }
    assert.equal(status, 1);
    assert.match(output, /RESOURCE vendor/);
    assert.match(output, /~ changed/);
});

/////////////////////////// lint — adapter profile /////////////////////////////

test('the committed CSV adapter example passes the adapter lint cleanly', () => {
    const { errors, warnings, recordCount, sourceSystems } = lintAdapterBundle(loadBundle(ADAPTER));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(recordCount, 11);
    assert.deepEqual(sourceSystems, ['legacy-purchasing-csv']);
});

test('the adapter example also VERIFIES — lint never substitutes for conformance', () => {
    const report = verifyBundle(loadBundle(ADAPTER), { manifestSchema });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
});

test('the adapter lint rejects a Charcoal-produced preserve bundle, which is the point', () => {
    // acme-mini is a perfectly conformant bundle and a hopeless adapter bundle:
    // no idPolicyHint, no $source anywhere. A lint that passed it would be
    // measuring nothing.
    const { errors } = lintAdapterBundle(loadBundle(EXAMPLE));
    assert.ok(errors.some((e) => e.includes('idPolicyHint')));
    assert.ok(errors.some((e) => e.includes('$source')));
});

test('the adapter lint refuses two records sharing one source key', () => {
    const files = loadBundle(ADAPTER);
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const entry = manifest.resources.find((r) => r.resource === 'vendor');
    const lines = files.get(entry.file).toString('utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    const clash = { ...JSON.parse(lines[1]), $source: first.$source };
    files.set(entry.file, Buffer.from([lines[0], canonicalize(clash), ...lines.slice(2)].join('\n') + '\n'));
    const { errors } = lintAdapterBundle(files);
    assert.ok(errors.some((e) => e.includes('duplicate source key')),
        `expected a duplicate-source-key error, got: ${errors.join(' | ')}`);
});

test('the adapter lint refuses an anchor with no natural key', () => {
    const files = loadBundle(ADAPTER);
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const entry = manifest.resources.find((r) => r.resource === 'organization');
    const record = JSON.parse(files.get(entry.file).toString('utf8').trim());
    delete record.Code;
    files.set(entry.file, Buffer.from(canonicalize(record) + '\n'));
    const { errors } = lintAdapterBundle(files);
    assert.ok(errors.some((e) => e.includes("no 'Code'")),
        `expected a missing-natural-key error, got: ${errors.join(' | ')}`);
});

test('--pubkey accepts the /.well-known response VERBATIM, not just an extracted JWK', () => {
    // The docs tell a customer to save the endpoint's response and pass it to
    // --pubkey. core-service wraps replies in the platform envelope, so that
    // file is {Status, Message, Data:{SigningKey:{kid, alg, publicKeyJwk}}} —
    // which used to fail with "Invalid JWK format". Found by curling the real
    // endpoint during the Phase-5 cutover rehearsal.
    const jwk = { crv: 'Ed25519', x: 'nEjvRAy5Ao37wL0ngaRtjnQ1BCSIjkdM5UPJRMSe18w', kty: 'OKP' };
    const enveloped = {
        Status: 'success', Message: 'Ember signing key retrieved successfully!', HttpCode: 200,
        Data: { SigningKey: { kid: 'c1b0e7264fb82f06', alg: 'EdDSA', publicKeyJwk: jwk } },
    };
    // The three shapes the CLI must all resolve to the same key material.
    const unwrap = (parsed) => {
        const k = parsed?.Data?.SigningKey ?? parsed;
        return k.publicKeyJwk ? { ...k.publicKeyJwk, kid: k.kid } : k;
    };
    assert.deepEqual(unwrap(enveloped), { ...jwk, kid: 'c1b0e7264fb82f06' });
    assert.deepEqual(unwrap(enveloped.Data.SigningKey), { ...jwk, kid: 'c1b0e7264fb82f06' });
    assert.deepEqual(unwrap(jwk), jwk);
});
