#!/usr/bin/env node
// CLI for the Ember bundle reference validator. See ../src/ember.mjs and
// docs/reference/ember-bundle-format-1.0.md.
//
//   ember-validate verify <bundle.czx | exploded-dir> [--strict] [--pubkey <file>] [--passphrase <p>]
//   ember-validate info   <bundle.czx | exploded-dir> [--passphrase <p>]
//   ember-validate diff   <bundleA> <bundleB> [--passphrase <p>]
//   ember-validate lint   <bundle.czx | exploded-dir>     (adapter-bundle profile)
//   ember-validate lint   <mapping-spec.json>            (IS-0 — Import Studio)
//
// --pubkey <file>: a JSON file holding either the bare public JWK
// ({"kty":"OKP","crv":"Ed25519","x":"..."}) or the full
// GET /.well-known/ember-signing-key response body ({kid, alg, publicKeyJwk}) —
// a customer typically saves that endpoint's response verbatim. Without
// --pubkey, a present manifest.sig is structure-checked only (§8.4).
// --passphrase <p> (or env EMBER_BUNDLE_PASSPHRASE): required when the target
// is a `.czx.enc` (Phase 3 unit 3) — decrypted in memory before the normal
// pipeline runs.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle, verifyBundle, bundleInfo, validateSchema, diffBundles, lintAdapterBundle } from '../src/ember.mjs';

const HERE = join(fileURLToPath(import.meta.url), '..');
const manifestSchema = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'manifest.schema.json'), 'utf8'));

const [, , command, target, ...rest] = process.argv;

if (!command || !target || !['verify', 'info', 'diff', 'lint'].includes(command)) {
    console.error('usage: ember-validate <verify|info|diff|lint> <bundle.czx | exploded-dir | mapping-spec.json> [<bundleB>] [--strict] [--pubkey <file>] [--passphrase <p>]');
    process.exit(2);
}

const passphraseOf = (flagList) => {
    const i = flagList.indexOf('--passphrase');
    return i > -1 ? flagList[i + 1] : process.env.EMBER_BUNDLE_PASSPHRASE;
};

if (command === 'diff') {
    const bundleB = rest[0];
    if (!bundleB) {
        console.error('usage: ember-validate diff <bundleA> <bundleB> [--passphrase <p>]');
        process.exit(2);
    }
    const flags = rest.slice(1);
    const passphrase = passphraseOf(flags);
    const filesA = loadBundle(target, { passphrase });
    const filesB = loadBundle(bundleB, { passphrase });
    const deltas = diffBundles(filesA, filesB);
    if (deltas.length === 0) {
        console.log('  ✓ no record-level deltas (data-identical, ignoring manifest.json volatile fields)');
        process.exit(0);
    }
    for (const d of deltas) {
        console.log(`RESOURCE ${d.resource}`);
        if (d.added.length > 0) console.log(`  + added   (${d.added.length}): ${d.added.join(', ')}`);
        if (d.removed.length > 0) console.log(`  - removed (${d.removed.length}): ${d.removed.join(', ')}`);
        if (d.changed.length > 0) {
            console.log(`  ~ changed (${d.changed.length}):`);
            for (const c of d.changed) {
                const fieldStr = Object.entries(c.fields)
                    .map(([k, v]) => `${k}: ${JSON.stringify(v.before)} -> ${JSON.stringify(v.after)}`)
                    .join('; ');
                console.log(`      ${c.id}: ${fieldStr}`);
            }
        }
    }
    process.exit(1); // deltas found — non-zero so CI/scripts can gate on it
}

const flags = rest;

if (command === 'lint') {
    // Two lints under one verb, dispatched on what the target IS — a bundle
    // (directory or .czx) gets the ADAPTER profile, a .json file gets the
    // MappingSpec check. There is no ambiguity to resolve: a MappingSpec is
    // never a directory and a bundle is never a bare .json.
    const isBundle = statSync(target).isDirectory() || /\.czx(\.enc)?$/.test(target);
    if (isBundle) {
        const files = loadBundle(target, { passphrase: passphraseOf(rest) });
        const { errors, warnings, recordCount, sourceSystems } = lintAdapterBundle(files);
        for (const e of errors) console.log(`  ✗ [adapter] ${e}`);
        for (const w of warnings) console.log(`  ⚠ [adapter] ${w}`);
        console.log(
            `\n${errors.length === 0 ? '  ✓' : '  ✗'} ${target}: ${errors.length} error(s), ${warnings.length} warning(s) ` +
            `over ${recordCount} record(s)` +
            (sourceSystems.length > 0 ? `; source system(s): ${sourceSystems.join(', ')}` : ''));
        if (errors.length === 0) {
            console.log('  adapter profile: $source on every record, allocate hint, anchors by natural key, catalog refs resolvable.');
            console.log('  Note: `lint` does NOT replace `verify` — run both.');
        }
        process.exit(errors.length > 0 ? 1 : 0);
    }

    const mappingSpecSchema = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'mapping-spec-1.0.schema.json'), 'utf8'));
    let spec;
    try {
        spec = JSON.parse(readFileSync(target, 'utf8'));
    } catch (err) {
        console.error(`  ✗ ${target}: ${err.message}`);
        process.exit(1);
    }
    const errors = validateSchema(spec, mappingSpecSchema);
    for (const e of errors) console.log(`  ✗ [mapping-spec] ${e}`);
    if (errors.length === 0) {
        console.log(`  ✓ ${target}: valid MappingSpec (specVersion ${spec.specVersion}, ${spec.entities?.length ?? 0} entities)`);
    }
    process.exit(errors.length > 0 ? 1 : 0);
}

const pubkeyArgIdx = flags.indexOf('--pubkey');
let pubkeyJwk;
if (pubkeyArgIdx > -1) {
    const pubkeyFile = flags[pubkeyArgIdx + 1];
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(pubkeyFile, 'utf8'));
    } catch (err) {
        console.error(`  ✗ --pubkey ${pubkeyFile}: ${err.message}`);
        process.exit(1);
    }
    // Three accepted shapes, because a customer will hand us whichever one they
    // happen to have — and the one the docs told them to save turned out NOT to
    // work (found by actually curling the endpoint during the Phase-5 cutover
    // rehearsal): core-service wraps its replies in the platform's standard
    // envelope, so `curl /.well-known/ember-signing-key > key.json` yields
    // {Status, Message, Data:{SigningKey:{kid, alg, publicKeyJwk}}}, not the
    // bare {kid, alg, publicKeyJwk}. Unwrapping it here is the fix: the
    // alternative is telling every departing customer to hand-edit JSON before
    // they can check a signature, which is exactly the friction this whole
    // standalone-validator design exists to avoid.
    const signingKey = parsed?.Data?.SigningKey ?? parsed;
    pubkeyJwk = signingKey.publicKeyJwk
        ? { ...signingKey.publicKeyJwk, kid: signingKey.kid }
        : signingKey;
}

const files = loadBundle(target, { passphrase: passphraseOf(flags) });

if (command === 'info') {
    const { manifest, bundleDigest } = bundleInfo(files);
    console.log(`bundle       ${manifest.bundleId} (${manifest.bundleType}, profile=${manifest.profile})`);
    console.log(`format       ${manifest.formatVersion}   producer ${manifest.producer?.product} ${manifest.producer?.version}`);
    console.log(`organization ${manifest.organization?.code} — ${manifest.organization?.legalName ?? ''} (${manifest.organization?.companies?.length ?? 0} companies)`);
    console.log(`resources    ${manifest.resources?.length ?? 0}, records ${manifest.resources?.reduce((a, r) => a + (r.recordCount ?? 0), 0)}`);
    console.log(`bundleDigest sha256:${bundleDigest}`);
    process.exit(0);
}

const report = verifyBundle(files, { manifestSchema, pubkeyJwk });
const stages = ['container', 'digests', 'manifest', 'records', 'schemas', 'references', 'blobs', 'signature'];

for (const f of report.findings) {
    const tag = f.level === 'error' ? '✗' : '⚠';
    console.log(`  ${tag} [${stages[f.stage] ?? f.stage}] ${f.path}: ${f.message}`);
}
const failed = report.errors.length > 0 || (flags.includes('--strict') && report.warnings.length > 0);
if (!failed) {
    console.log(`  ✓ ${files.size} files, ${report.recordTotal} records, 0 errors, ${report.warnings.length} warning(s)`);
    console.log(`  ✓ bundleDigest sha256:${report.bundleDigest}`);
}
process.exit(failed ? 1 : 0);
