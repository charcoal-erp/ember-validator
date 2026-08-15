///////////////////////////////////////////////////////////////////////////////
//
// @charcoal/ember-validator — reference validator for the Ember bundle format.
//
// Written against docs/reference/ember-bundle-format-1.0.md and deliberately
// independent of any exporter/importer implementation (Phase 0 discipline: the
// validator is a real check on the spec, not a restatement of the code).
//
// Zero runtime dependencies — this tool must run standalone on a customer's
// machine with nothing but Node >= 18.
//
///////////////////////////////////////////////////////////////////////////////

import { createDecipheriv, createHash, createPublicKey, scryptSync, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const SUPPORTED_FORMAT_MAJOR = 1;

const TYPED_REF_RE = /^([a-z][a-z0-9_]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BLOB_REF_RE = /^blob:sha256-([0-9a-f]{64})$/;
const CATALOG_RESOURCES = new Set(['role', 'permission']);
const AUDIT_KEYS = new Set(['CreatedBy', 'UpdatedBy']);

///////////////////////////////// canonical ///////////////////////////////////

const sortValue = (v) => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
        return out;
    }
    return v;
};

// RFC 8785-compatible for the JSON subset the spec allows (ES number
// formatting IS the JCS number formatting).
export const canonicalize = (value) => JSON.stringify(sortValue(value));

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// timingSafeEqual requires equal-length buffers; unequal length is itself a
// safe (if not constant-time against length) mismatch signal. Same
// discipline as platform-compliance-gateway's webhook.verify.ts.
const constantTimeEqual = (a, b) => {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

///////////////////////////////// zip reader //////////////////////////////////

// Minimal ZIP reader: central-directory driven, STORE + DEFLATE, zip64-aware
// for the size/offset fields this validator needs.
export const readZip = (buffer) => {
    // Find End Of Central Directory (scan back over the comment).
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('not a zip archive (no end-of-central-directory)');

    let count = buffer.readUInt16LE(eocd + 10);
    let cdOffset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
        // zip64: locator sits 20 bytes before EOCD.
        const loc = eocd - 20;
        if (loc >= 0 && buffer.readUInt32LE(loc) === 0x07064b50) {
            const z64 = Number(buffer.readBigUInt64LE(loc + 8));
            if (buffer.readUInt32LE(z64) !== 0x06064b50) throw new Error('bad zip64 EOCD');
            count = Number(buffer.readBigUInt64LE(z64 + 32));
            cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
        }
    }

    const files = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
        const method = buffer.readUInt16LE(p + 10);
        let compSize = buffer.readUInt32LE(p + 20);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        let localOffset = buffer.readUInt32LE(p + 42);
        const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

        // zip64 extra field (0x0001) may override 0xffffffff fields.
        let ep = p + 46 + nameLen;
        const extraEnd = ep + extraLen;
        while (ep + 4 <= extraEnd) {
            const tag = buffer.readUInt16LE(ep);
            const size = buffer.readUInt16LE(ep + 2);
            if (tag === 0x0001) {
                let fp = ep + 4;
                const uncompressed = buffer.readUInt32LE(p + 24);
                if (uncompressed === 0xffffffff) fp += 8;
                if (compSize === 0xffffffff) { compSize = Number(buffer.readBigUInt64LE(fp)); fp += 8; }
                if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(fp));
            }
            ep += 4 + size;
        }

        if (!name.endsWith('/')) {
            const lhNameLen = buffer.readUInt16LE(localOffset + 26);
            const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
            const raw = buffer.subarray(dataStart, dataStart + compSize);
            if (method === 0) files.set(name, Buffer.from(raw));
            else if (method === 8) files.set(name, inflateRawSync(raw));
            else throw new Error(`unsupported compression method ${method} for ${name}`);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
};

//////////////////////////////// bundle loader ////////////////////////////////

const walkDir = (root, dir, out) => {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkDir(root, full, out);
        else out.set(relative(root, full).split(sep).join('/'), readFileSync(full));
    }
    return out;
};

// Returns Map<path, Buffer> for either a .czx zip or an exploded directory.
// Phase 3 unit 3 (§2.1/§9.4): a `.czx.enc` is a whole-file AES-256-GCM wrap of
// a sealed `.czx` — MAGIC(8="EMBRENC1") SALT(16) IV(12) CIPHERTEXT TAG(16,
// trailing). Deliberately a SEPARATE implementation from
// platform-bundle's own encryption.ts (same "producer and validator never
// share code" discipline already applied to signing) — decrypts in memory
// (this validator already loads a whole zip into memory via readZip, so no
// new memory-shape here) and hands the plaintext straight to readZip.
const ENC_MAGIC = Buffer.from('EMBRENC1', 'utf8');
const ENC_SALT_LEN = 16;
const ENC_IV_LEN = 12;
const ENC_TAG_LEN = 16;

export const isEncryptedBundleFile = (buf) =>
    buf.length >= ENC_MAGIC.length && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);

export const decryptBundleFile = (buf, passphrase) => {
    const headerLen = ENC_MAGIC.length + ENC_SALT_LEN + ENC_IV_LEN;
    if (buf.length < headerLen + ENC_TAG_LEN) throw new Error('not an Ember-encrypted file (too short)');
    if (!isEncryptedBundleFile(buf)) throw new Error('not an Ember-encrypted file (bad magic)');
    const salt = buf.subarray(ENC_MAGIC.length, ENC_MAGIC.length + ENC_SALT_LEN);
    const iv = buf.subarray(ENC_MAGIC.length + ENC_SALT_LEN, headerLen);
    const tag = buf.subarray(buf.length - ENC_TAG_LEN);
    const ciphertext = buf.subarray(headerLen, buf.length - ENC_TAG_LEN);
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag); // throws on final() below if tampered or wrong passphrase
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

export const loadBundle = (path, opts = {}) => {
    const st = statSync(path);
    if (st.isDirectory()) return walkDir(path, path, new Map());
    let buf = readFileSync(path);
    if (isEncryptedBundleFile(buf)) {
        if (!opts.passphrase) throw new Error(`${path}: this bundle is encrypted — pass --passphrase`);
        buf = decryptBundleFile(buf, opts.passphrase);
    }
    return readZip(buf);
};

////////////////////////////////// diff ////////////////////////////////////////

// Phase 3 unit 4: per-resource record deltas between two bundles, by $id,
// canonical compare. Deliberately resource-scoped — manifest.json itself is
// NEVER diffed as a "resource" here, so the R3-era data-identical methodology
// (manifest.json's own volatile fields — createdAt, consistency[], bundleId —
// legitimately differ between two exports of identical data) never produces
// spurious findings. This is also the Phase-2 exit gate's reporting tool.
const parseResourceRecords = (files, manifest) => {
    const byResource = new Map();
    for (const r of manifest.resources ?? []) {
        const buf = files.get(r.file);
        if (!buf) continue;
        const records = new Map();
        const text = buf.toString('utf8');
        const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
        for (const line of lines) {
            if (!line) continue;
            const rec = JSON.parse(line);
            records.set(rec.$id, rec);
        }
        byResource.set(r.resource, records);
    }
    return byResource;
};

/**
 * @returns {Array<{resource, added: string[], removed: string[], changed: Array<{id, fields}>}>}
 * Only resources with at least one delta are included. `fields` maps field
 * name -> {before, after} for every top-level key (incl. $v; other $-prefixed
 * envelope keys are ignored) whose canonical value differs.
 */
export const diffBundles = (filesA, filesB) => {
    const manifestA = JSON.parse(filesA.get('manifest.json').toString('utf8'));
    const manifestB = JSON.parse(filesB.get('manifest.json').toString('utf8'));
    const recA = parseResourceRecords(filesA, manifestA);
    const recB = parseResourceRecords(filesB, manifestB);
    const resources = [...new Set([...recA.keys(), ...recB.keys()])].sort();

    const result = [];
    for (const resource of resources) {
        const a = recA.get(resource) ?? new Map();
        const b = recB.get(resource) ?? new Map();
        const added = [...b.keys()].filter((id) => !a.has(id)).sort();
        const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
        const changed = [];
        for (const [id, recordA] of a) {
            if (!b.has(id)) continue;
            const recordB = b.get(id);
            if (canonicalize(recordA) === canonicalize(recordB)) continue;
            const fields = {};
            for (const k of new Set([...Object.keys(recordA), ...Object.keys(recordB)])) {
                if (k.startsWith('$') && k !== '$v') continue;
                const va = recordA[k];
                const vb = recordB[k];
                if (canonicalize(va) !== canonicalize(vb)) fields[k] = { before: va, after: vb };
            }
            if (Object.keys(fields).length > 0) changed.push({ id, fields });
        }
        changed.sort((x, y) => (x.id < y.id ? -1 : 1));
        if (added.length > 0 || removed.length > 0 || changed.length > 0) {
            result.push({ resource, added, removed, changed });
        }
    }
    return result;
};

/////////////////////////// JSON-Schema (subset) //////////////////////////////

// The spec's schemas use a constrained subset; supporting it natively keeps
// the validator dependency-free. Unknown keywords are ignored (tolerant).
/** Resolve a local `#/$defs/<name>` pointer against `root`. No external/remote $ref — every schema this validator checks is a single self-contained document. */
const resolveRef = (ref, root) => {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    if (!m || !root.$defs || !root.$defs[m[1]]) {
        throw new Error(`validateSchema: unresolvable $ref '${ref}'`);
    }
    return root.$defs[m[1]];
};

export const validateSchema = (value, schema, path = '$', errors = [], root = schema) => {
    if (!schema || typeof schema !== 'object') return errors;

    if (schema.$ref) {
        return validateSchema(value, resolveRef(schema.$ref, root), path, errors, root);
    }

    if (schema.oneOf || schema.anyOf) {
        const branches = schema.oneOf ?? schema.anyOf;
        const matched = branches.some((branch) => validateSchema(value, branch, path, [], root).length === 0);
        if (!matched) {
            errors.push(`${path}: does not match any of the ${branches.length} allowed shapes`);
        }
        return errors;
    }

    if (schema.const !== undefined && canonicalize(value) !== canonicalize(schema.const)) {
        errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
        return errors;
    }
    if (schema.enum && !schema.enum.some((e) => canonicalize(e) === canonicalize(value))) {
        errors.push(`${path}: value not in enum [${schema.enum.join(', ')}]`);
        return errors;
    }

    const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
    if (types) {
        const actual =
            value === null ? 'null'
            : Array.isArray(value) ? 'array'
            : Number.isInteger(value) ? 'integer'
            : typeof value;
        const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
        if (!ok) {
            errors.push(`${path}: expected type ${types.join('|')}, got ${actual}`);
            return errors;
        }
    }

    if (typeof value === 'string') {
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
            errors.push(`${path}: does not match pattern ${schema.pattern}`);
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push(`${path}: shorter than minLength ${schema.minLength}`);
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
        }
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push(`${path}: below minimum ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push(`${path}: above maximum ${schema.maximum}`);
        }
    }

    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(`${path}: fewer than minItems ${schema.minItems}`);
        }
        if (schema.items) {
            value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`, errors, root));
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const req of schema.required ?? []) {
            if (!(req in value)) errors.push(`${path}: missing required property '${req}'`);
        }
        const props = schema.properties ?? {};
        for (const [k, v] of Object.entries(value)) {
            if (props[k]) validateSchema(v, props[k], `${path}.${k}`, errors, root);
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                validateSchema(v, schema.additionalProperties, `${path}.${k}`, errors, root);
            } else if (schema.additionalProperties === false && !k.startsWith('$')) {
                errors.push(`${path}: unexpected property '${k}'`);
            }
        }
    }
    return errors;
};

////////////////////////////////// findings ///////////////////////////////////

class Report {
    constructor() { this.findings = []; }

    error(stage, path, message) { this.findings.push({ stage, level: 'error', path, message }); }

    warn(stage, path, message) { this.findings.push({ stage, level: 'warning', path, message }); }

    get errors() { return this.findings.filter((f) => f.level === 'error'); }

    get warnings() { return this.findings.filter((f) => f.level === 'warning'); }
}

const parseNdjson = (buf, path, report, stage) => {
    const text = buf.toString('utf8');
    if (text.length > 0 && !text.endsWith('\n')) {
        report.error(stage, path, 'last record line is not newline-terminated');
    }
    const records = [];
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
    lines.forEach((line, i) => {
        try {
            const value = JSON.parse(line);
            if (canonicalize(value) !== line) {
                report.error(stage, path, `line ${i + 1}: not in canonical form`);
            }
            records.push(value);
        } catch {
            report.error(stage, path, `line ${i + 1}: invalid JSON`);
        }
    });
    return records;
};

// Recursively find every typed-reference / blob-reference string value.
const collectRefs = (value, inAudit, out) => {
    if (typeof value === 'string') {
        const t = TYPED_REF_RE.exec(value);
        if (t) out.push({ ref: value, resource: t[1], inAudit });
        const b = BLOB_REF_RE.exec(value);
        if (b) out.push({ blob: b[1] });
        return;
    }
    if (Array.isArray(value)) { for (const v of value) collectRefs(v, inAudit, out); return; }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            // $embeds holds whole child RECORDS (spec §5). Their $id is their
            // own identity, not a reference out of the parent, and their
            // fields get their own reference pass — walking them here would
            // report every embedded child as a dangling reference.
            if (k === EMBEDS_KEY) continue;
            collectRefs(v, inAudit || k === '$audit' || AUDIT_KEYS.has(k), out);
        }
    }
};

// Spec §5 — children carried inside a parent record. PORTED here deliberately:
// the validator never imports from platform-bundle (producer and validator
// must not share code), so this is an independent reading of the same spec.
const EMBEDS_KEY = '$embeds';

/** Flatten a parent's $embeds into {resource, record} pairs. */
const embeddedOf = (record) => {
    const bag = record[EMBEDS_KEY];
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
    const out = [];
    for (const [resource, rows] of Object.entries(bag)) {
        if (!Array.isArray(rows)) continue;
        for (const r of rows) out.push({ resource, record: r });
    }
    return out;
};

/////////////////////////////////// verify ////////////////////////////////////

export const verifyBundle = (files, { manifestSchema, pubkeyJwk } = {}) => {
    const report = new Report();

    // Stage 0 — container.
    if (!files.has('manifest.json')) { report.error(0, 'manifest.json', 'missing'); return report; }
    if (!files.has('checksums.sha256')) { report.error(0, 'checksums.sha256', 'missing'); return report; }

    // Stage 1 — digest chain.
    const sumsText = files.get('checksums.sha256').toString('utf8');
    const covered = new Map();
    let prevPath = '';
    for (const [i, line] of sumsText.split('\n').filter(Boolean).entries()) {
        const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
        if (!m) { report.error(1, 'checksums.sha256', `line ${i + 1}: malformed`); continue; }
        if (m[2] < prevPath) report.error(1, 'checksums.sha256', `line ${i + 1}: not sorted by path`);
        prevPath = m[2];
        covered.set(m[2], m[1]);
    }
    for (const [path, digest] of covered) {
        const buf = files.get(path);
        if (!buf) report.error(1, path, 'listed in checksums.sha256 but missing from bundle');
        else if (sha256(buf) !== digest) report.error(1, path, 'digest mismatch');
    }
    for (const path of files.keys()) {
        if (path === 'checksums.sha256' || path === 'manifest.sig') continue;
        if (!covered.has(path)) report.error(1, path, 'present in bundle but not covered by checksums.sha256');
    }
    const bundleDigest = sha256(files.get('checksums.sha256'));

    // Stage 2 — manifest.
    let manifest;
    try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); }
    catch { report.error(2, 'manifest.json', 'invalid JSON'); return report; }
    if (manifestSchema) {
        for (const e of validateSchema(manifest, manifestSchema, 'manifest')) report.error(2, 'manifest.json', e);
    }
    const major = parseInt(String(manifest.formatVersion ?? '').split('.')[0], 10);
    if (major !== SUPPORTED_FORMAT_MAJOR) {
        report.error(2, 'manifest.json', `formatVersion '${manifest.formatVersion}' unsupported (this validator: ${SUPPORTED_FORMAT_MAJOR}.x)`);
        return report;
    }
    const resources = manifest.resources ?? [];
    const byName = new Map(resources.map((r) => [r.resource, r]));
    // Spec §5: an embedded resource is PRESENT in the bundle — inside its
    // parent's records — it simply has no entry of its own. It therefore
    // satisfies a dependsOn edge exactly as a top-level resource does.
    const embeddedResources = new Set(resources.flatMap((r) => r.embeds ?? []));
    for (const r of resources) {
        if (!files.has(r.file)) report.error(2, r.file, `data file for resource '${r.resource}' missing`);
        if (r.schema && !files.has(r.schema)) report.error(2, r.schema, `schema for resource '${r.resource}' missing`);
        if (embeddedResources.has(r.resource)) {
            report.error(2, r.file, `'${r.resource}' is declared in another resource's embeds AND ships its own data file — an embedded child must live in exactly one place (§5)`);
        }
        for (const dep of r.dependsOn ?? []) {
            if (!byName.has(dep) && !CATALOG_RESOURCES.has(dep) && !embeddedResources.has(dep)) {
                report.warn(2, r.file, `dependsOn '${dep}' is not a resource in this bundle`);
            }
        }
    }
    // dependsOn must be a DAG.
    const state = new Map();
    const visit = (name, stack) => {
        if (state.get(name) === 'done') return;
        if (state.get(name) === 'visiting') {
            report.error(2, 'manifest.json', `dependsOn cycle: ${[...stack, name].join(' -> ')}`);
            return;
        }
        state.set(name, 'visiting');
        for (const dep of byName.get(name)?.dependsOn ?? []) if (byName.has(dep)) visit(dep, [...stack, name]);
        state.set(name, 'done');
    };
    for (const r of resources) visit(r.resource, []);

    // Stage 3 — records.
    const idIndex = new Set();
    const allRecords = [];
    const embeddedRecords = [];
    for (const r of resources) {
        const buf = files.get(r.file);
        if (!buf) continue;
        if (sha256(buf) !== r.sha256) report.error(3, r.file, 'sha256 does not match manifest');
        const records = parseNdjson(buf, r.file, report, 3);
        if (records.length !== r.recordCount) {
            report.error(3, r.file, `recordCount ${records.length} != manifest ${r.recordCount}`);
        }
        let prevId = '';
        for (const rec of records) {
            if (typeof rec.$id !== 'string' || !TYPED_REF_RE.test(rec.$id)) {
                report.error(3, r.file, `record missing/invalid $id: ${JSON.stringify(rec.$id)}`);
                continue;
            }
            if (!rec.$id.startsWith(`${r.resource}:`)) {
                report.error(3, r.file, `$id '${rec.$id}' does not match resource '${r.resource}'`);
            }
            if (typeof rec.$v !== 'number') report.error(3, r.file, `${rec.$id}: missing $v`);
            else if (rec.$v !== r.resourceVersion) {
                report.warn(3, r.file, `${rec.$id}: $v ${rec.$v} != manifest resourceVersion ${r.resourceVersion}`);
            }
            if (rec.$op && !['upsert', 'delete', 'patch'].includes(rec.$op)) {
                report.error(3, r.file, `${rec.$id}: invalid $op '${rec.$op}'`);
            }
            if (rec.$id < prevId) report.error(3, r.file, `records not sorted by $id at '${rec.$id}'`);
            prevId = rec.$id;
            if (idIndex.has(rec.$id)) report.error(3, r.file, `duplicate $id '${rec.$id}'`);
            idIndex.add(rec.$id);
            allRecords.push({ record: rec, file: r.file });
            // Embedded children are real records that simply live inside their
            // parent: they must be indexed so references to them resolve, and
            // they must be schema- and reference-checked like any other row.
            const declared = new Set(r.embeds ?? []);
            for (const { resource, record: child } of embeddedOf(rec)) {
                if (!declared.has(resource)) {
                    report.error(3, r.file, `${rec.$id}: $embeds carries '${resource}', which this resource's manifest entry does not declare in embeds`);
                    continue;
                }
                if (typeof child.$id !== 'string' || !TYPED_REF_RE.test(child.$id)) {
                    report.error(3, r.file, `${rec.$id}: embedded ${resource} record has a missing or malformed $id`);
                    continue;
                }
                if (!child.$id.startsWith(`${resource}:`)) {
                    report.error(3, r.file, `${rec.$id}: embedded record '${child.$id}' does not carry its own resource prefix '${resource}:'`);
                    continue;
                }
                if (idIndex.has(child.$id)) report.error(3, r.file, `duplicate $id '${child.$id}' (embedded)`);
                idIndex.add(child.$id);
                embeddedRecords.push({ record: child, file: r.file, resource, parentId: rec.$id });
            }
        }
    }

    // Catalog ids resolve typed refs to catalog resources.
    for (const path of files.keys()) {
        if (path.startsWith('catalog/') && path.endsWith('.ndjson')) {
            for (const rec of parseNdjson(files.get(path), path, report, 3)) {
                if (typeof rec.$id === 'string' && TYPED_REF_RE.test(rec.$id)) idIndex.add(rec.$id);
            }
        }
    }

    // Stage 4 — schemas.
    const schemaCache = new Map();
    for (const r of resources) {
        const sbuf = r.schema ? files.get(r.schema) : null;
        if (!sbuf) continue;
        let schema;
        try { schema = JSON.parse(sbuf.toString('utf8')); }
        catch { report.error(4, r.schema, 'schema is not valid JSON'); continue; }
        if (canonicalize(schema) !== sbuf.toString('utf8').trimEnd()) {
            report.error(4, r.schema, 'schema file is not in canonical form');
        }
        schemaCache.set(r.file, schema);
    }
    for (const { record, file } of allRecords) {
        const schema = schemaCache.get(file);
        if (!schema) continue;
        const domain = Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('$')));
        for (const e of validateSchema(domain, schema, record.$id)) report.error(4, file, e);
    }

    // Embedded children carry no manifest entry, so their schema is located by
    // resource name among the shipped schema files (spec §5: the child is a
    // full record in its own right and MUST still validate).
    const schemaByResource = new Map();
    for (const path of files.keys()) {
        const m = /^schema\/[^/]+\.([a-z0-9_]+)\.v\d+\.schema\.json$/.exec(path);
        if (!m) continue;
        try { schemaByResource.set(m[1], JSON.parse(files.get(path).toString('utf8'))); } catch { /* reported in stage 4 */ }
    }
    for (const { record, file, resource, parentId } of embeddedRecords) {
        const schema = schemaByResource.get(resource);
        if (!schema) {
            report.warn(4, file, `embedded resource '${resource}' ships no schema file, so its records cannot be validated`);
            continue;
        }
        const domain = Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('$')));
        // §5: the back-reference to the parent is OMITTED inside an embed
        // because the enclosing $id determines it. Reconstruct it before
        // schema validation, or every embedded child fails its own
        // `required` check. The column is identified from the schema itself —
        // the property whose typed-ref pattern names the parent resource —
        // so no descriptor knowledge leaks into the validator.
        const parentResource = parentId.slice(0, parentId.indexOf(':'));
        for (const [prop, spec] of Object.entries(schema.properties ?? {})) {
            if (spec && spec.pattern === `^${parentResource}:` && !(prop in domain)) domain[prop] = parentId;
        }
        for (const e of validateSchema(domain, schema, record.$id)) report.error(4, file, e);
    }

    // Stage 5 — referential closure. Stage 6 — blobs.
    const blobIndexPath = manifest.blobs?.index ?? 'blobs/index.ndjson';
    const blobRecords = files.has(blobIndexPath) ? parseNdjson(files.get(blobIndexPath), blobIndexPath, report, 6) : [];
    const indexedBlobs = new Set();
    for (const rec of blobRecords) {
        const m = typeof rec.Content === 'string' ? BLOB_REF_RE.exec(rec.Content) : null;
        if (m) indexedBlobs.add(m[1]);
    }
    const blobPath = (h) => `blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;
    const checkBlob = (hash, from) => {
        const buf = files.get(blobPath(hash));
        if (!buf) report.error(6, from, `blob sha256-${hash.slice(0, 12)}… missing from blobs/`);
        else if (sha256(buf) !== hash) report.error(6, blobPath(hash), 'blob bytes do not hash to their address');
    };
    for (const { record, file } of [...allRecords, ...embeddedRecords]) {
        const refs = [];
        collectRefs(record, false, refs);
        for (const ref of refs) {
            if (ref.blob) { checkBlob(ref.blob, file); continue; }
            if (idIndex.has(ref.ref)) continue;
            if (ref.resource === 'user' && ref.inAudit) {
                report.warn(5, file, `${record.$id}: audit reference '${ref.ref}' does not resolve in-bundle`);
            } else if (CATALOG_RESOURCES.has(ref.resource)) {
                report.error(5, file, `${record.$id}: catalog reference '${ref.ref}' has no catalog/ entry`);
            } else {
                report.error(5, file, `${record.$id}: reference '${ref.ref}' does not resolve in-bundle`);
            }
        }
    }
    for (const hash of indexedBlobs) checkBlob(hash, blobIndexPath);
    // Orphan blob payloads are a warning (dedup may legitimately outlive references).
    for (const path of files.keys()) {
        if (path.startsWith('blobs/sha256/')) {
            const h = path.split('/').pop();
            if (!indexedBlobs.has(h)) report.warn(6, path, 'blob present but not listed in the blob index');
        }
    }

    // Stage 7 — signature (§8.4, optional in 1.0). Deliberately independent of
    // @charcoal/platform-bundle's own signing.ts — same signing-input
    // construction PORTED here (not imported), so producer and validator
    // never share signature code (a tampered producer can't tamper the
    // check that catches it). Structure is checked whenever manifest.sig is
    // present; the signature itself is checked only when a pubkeyJwk was
    // supplied (offline verification against a pinned key, per §9.3).
    const sigPath = 'manifest.sig';
    const hasSig = files.has(sigPath);
    if (pubkeyJwk && !hasSig) {
        report.error(7, sigPath, 'a public key was supplied for verification but the bundle has no manifest.sig');
    } else if (hasSig) {
        const sigText = files.get(sigPath).toString('utf8').trim();
        const parts = sigText.split('.');
        if (parts.length !== 3 || parts[1] !== '') {
            report.error(7, sigPath, 'not a detached compact JWS (expected <header>..<signature>)');
        } else {
            const [headerB64, , sigB64] = parts;
            let header;
            try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')); }
            catch { report.error(7, sigPath, 'protected header is not valid base64url JSON'); }
            if (header) {
                if (header.alg !== 'EdDSA') report.error(7, sigPath, `unsupported alg '${header.alg}' (expected EdDSA)`);
                if (!header.kid) report.warn(7, sigPath, 'protected header missing kid');
                if (!header.producer) report.error(7, sigPath, 'protected header missing required producer slot (§8.4)');
                if (pubkeyJwk) {
                    if (pubkeyJwk.kid && header.kid && !constantTimeEqual(header.kid, pubkeyJwk.kid)) {
                        report.error(7, sigPath, `signature kid '${header.kid}' does not match the supplied public key's kid '${pubkeyJwk.kid}'`);
                    } else if (header.alg === 'EdDSA') {
                        try {
                            const keyObj = createPublicKey({ key: pubkeyJwk, format: 'jwk' });
                            const payloadB64 = files.get('checksums.sha256').toString('base64url');
                            const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
                            const ok = cryptoVerify(null, signingInput, keyObj, Buffer.from(sigB64, 'base64url'));
                            if (!ok) report.error(7, sigPath, 'signature does not verify against the supplied public key and checksums.sha256');
                        } catch (err) {
                            report.error(7, sigPath, `signature verification failed: ${err.message}`);
                        }
                    }
                } else {
                    report.warn(7, sigPath, 'signature present but not cryptographically verified (no public key supplied)');
                }
            }
        }
    }

    report.bundleDigest = bundleDigest;
    report.manifest = manifest;
    report.recordTotal = allRecords.length;
    return report;
};

export const bundleInfo = (files) => {
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const digest = files.has('checksums.sha256') ? sha256(files.get('checksums.sha256')) : null;
    return { manifest, bundleDigest: digest };
};

///////////////////////////// lint: adapter profile ////////////////////////////

//
// Phase 5 unit 2 — the ADAPTER-BUNDLE lint profile.
//
// `verify` answers "is this a conformant Ember bundle?". This answers a
// narrower, later question: "will this bundle survive `ember-import --id-policy
// allocate` into a real tenant?" Every rule here exists because breaking it
// produces damage an operator only discovers afterwards — duplicated records on
// a re-run, a second empty company beside the real one, a role reference that
// resolves to a UUID from someone else's deployment.
//
// It is a LINT, not a stage of verify: an adapter bundle that fails these is
// still a legal Ember bundle. Producers of `preserve` bundles (Charcoal's own
// exporter) must not be held to any of it.
//

/** Resources an adapter REFERENCES but must never CREATE (importer: allocate.ts). */
const ANCHOR_RESOURCES = new Set(['organization', 'company']);

/** Natural key each anchor is resolved by on the target. */
const ANCHOR_NATURAL_KEY = { organization: ['Code'], company: ['Name'] };

/** Natural key each catalog file's entries must carry (spec §7). */
const CATALOG_NATURAL_KEY = {
    'catalog/roles.ndjson'       : ['Name'],
    'catalog/permissions.ndjson' : ['Name', 'ServiceName', 'Type'],
};

/**
 * @returns {{errors: string[], warnings: string[], recordCount: number, sourceSystems: string[]}}
 */
export const lintAdapterBundle = (files) => {
    const errors = [];
    const warnings = [];
    const err = (m) => errors.push(m);
    const warn = (m) => warnings.push(m);

    if (!files.has('manifest.json')) return { errors: ['manifest.json missing'], warnings, recordCount: 0, sourceSystems: [] };
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));

    // 1. The bundle must SAY it is meant for allocate. The importer does not
    //    read this hint (the operator's --id-policy is authoritative), which is
    //    exactly why it must be right: it is the adapter author's only way to
    //    tell the operator how the bundle expects to be loaded.
    const hint = manifest.options?.idPolicyHint;
    if (hint !== 'allocate') {
        err(`manifest.options.idPolicyHint is ${JSON.stringify(hint ?? null)} — an adapter bundle must declare 'allocate' (spec §4.2)`);
    }
    if (manifest.profile && manifest.profile !== 'migration') {
        warn(`manifest.profile is '${manifest.profile}' — adapter output is conventionally the 'migration' profile (spec §12)`);
    }

    // 2. Anchors: present so the bundle is referentially closed, resolved on
    //    the target by natural key, never inserted.
    const anchorsSeen = new Set();

    // 3. $source is REQUIRED on every non-anchor record: it is the identity
    //    map's key, so a record without one cannot be re-run idempotently.
    let recordCount = 0;
    let missingSource = 0;
    const firstMissing = [];
    const sourceSystems = new Set();
    const sourceKeys = new Map();       // 'system|resource|externalId' -> first $id
    const catalogRefs = [];

    const eachRecord = (resource, record, file) => {
        recordCount++;
        for (const child of embeddedOf(record)) eachRecord(child.resource, child.record, file);

        const refs = [];
        collectRefs(record, false, refs);
        for (const r of refs) {
            if (r.ref && CATALOG_RESOURCES.has(r.resource)) catalogRefs.push({ ...r, from: record.$id });
        }

        if (ANCHOR_RESOURCES.has(resource)) {
            anchorsSeen.add(resource);
            for (const key of ANCHOR_NATURAL_KEY[resource]) {
                const value = record[key];
                if (typeof value !== 'string' || value.length === 0) {
                    err(`${file}: anchor record ${record.$id} has no '${key}' — the importer resolves ${resource} anchors by that natural key and will refuse this bundle`);
                }
            }
            if (record.$source) {
                warn(`${file}: anchor record ${record.$id} carries $source — anchors are resolved on the target, never allocated, so it is ignored`);
            }
            return;
        }

        const source = record.$source;
        const system = source?.system;
        const externalId = source?.externalId;
        if (typeof system !== 'string' || system.length === 0 ||
            externalId === undefined || externalId === null || externalId === '') {
            missingSource++;
            if (firstMissing.length < 5) firstMissing.push(`${file}: ${record.$id}`);
            return;
        }
        sourceSystems.add(system);
        const key = `${system}‖${resource}‖${String(externalId)}`;
        if (sourceKeys.has(key)) {
            err(`duplicate source key {system:'${system}', externalId:'${externalId}'} on ${resource}: ${sourceKeys.get(key)} and ${record.$id} — both would map to ONE row, so one of them would be silently lost`);
        } else {
            sourceKeys.set(key, record.$id);
        }
    };

    for (const r of manifest.resources ?? []) {
        const buf = files.get(r.file);
        if (!buf) { err(`${r.file}: listed in the manifest but missing from the bundle`); continue; }
        const text = buf.toString('utf8');
        const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
        for (const line of lines) {
            if (!line) continue;
            let record;
            try { record = JSON.parse(line); } catch { err(`${r.file}: invalid JSON line — run \`ember-validate verify\` first`); continue; }
            eachRecord(r.resource, record, r.file);
        }
    }

    if (missingSource > 0) {
        err(`${missingSource} record(s) have no $source{system, externalId} — that pair is the identity map's key, so a re-run would mint new ids and DUPLICATE them (see the adapter guide). First: ${firstMissing.join(', ')}`);
    }
    if (!anchorsSeen.has('organization')) {
        err("no 'organization' record — an adapter bundle carries its target organization as an anchor so it is referentially closed and verifiable on its own (the importer resolves, never inserts it)");
    }

    // 4. Catalog references resolve by NATURAL KEY, never by a uuid the adapter
    //    invented: role/permission UUIDs are deployment-local (spec §7).
    const catalogIds = new Map();
    for (const [path, natural] of Object.entries(CATALOG_NATURAL_KEY)) {
        if (!files.has(path)) continue;
        const text = files.get(path).toString('utf8');
        const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
        for (const line of lines) {
            if (!line) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { err(`${path}: invalid JSON line`); continue; }
            catalogIds.set(entry.$id, path);
            const missing = natural.filter((k) => entry[k] === undefined || entry[k] === null || entry[k] === '');
            if (missing.length > 0) {
                err(`${path}: entry ${entry.$id} is missing its natural key (${missing.join(', ')}) — the target resolves catalog references by that key, and a deployment-local UUID means nothing there`);
            }
        }
    }
    for (const ref of catalogRefs) {
        if (!catalogIds.has(ref.ref)) {
            err(`${ref.from}: catalog reference '${ref.ref}' has no catalog/ entry — a ${ref.resource} UUID is deployment-local and unusable on the target (spec §7)`);
        }
    }

    // 5. Control totals: the migration profile's own honesty check.
    if (!files.has('controls/control-totals.ndjson')) {
        warn('no controls/control-totals.ndjson — declaring control totals (a trial balance, a vendor count, an open-AR figure) is how a migration proves it did not silently drop rows (spec §10). Strongly recommended.');
    }

    return { errors, warnings, recordCount, sourceSystems: [...sourceSystems].sort() };
};
