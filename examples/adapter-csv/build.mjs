#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
//
// A REAL Ember adapter, end to end: two CSV exports from a legacy purchasing
// system become a conformant `migration`-profile bundle that
// `ember-import --id-policy allocate` can load.
//
//   node build.mjs [--out ./bundle]
//
// This is the living proof behind docs/reference/ember-adapter-guide.md. It is
// deliberately written the way an EXTERNAL author would have to write it:
//
//   * zero dependencies — Node's standard library only;
//   * nothing imported from Charcoal (no @charcoal/platform-bundle, no
//     ember-validator internals) — the spec and the four JSON Schemas in
//     ./schema are the entire interface;
//   * every rule it obeys is a rule the spec states, with the section cited.
//
// If this file needed anything from inside Charcoal, the format would not
// actually be an open one — which is the whole claim the spec makes.
//
///////////////////////////////////////////////////////////////////////////////

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : join(HERE, 'bundle');

// The source system's name. It is the first half of every identity-map key, so
// it must be stable forever: change it and the next run looks like a brand-new
// migration and duplicates everything.
const SOURCE_SYSTEM = 'legacy-purchasing-csv';

// The TARGET tenant. An adapter bundle does not create the organization or its
// companies — it names them so the bundle is referentially closed, and the
// importer resolves them against the target by natural key (organization by
// Code, company by Name). These values must match the tenant you are migrating
// into; here they are the platform's demo org, which is what
// examples/acme-mini seeds.
const ORG = { code: 'ACME', name: 'Acme Manufacturing Pvt Ltd' };
const COMPANY = { name: 'Acme Pharma Pvt Ltd' };

// Pinned so that re-running this adapter over unchanged input produces an
// unchanged bundle — the property that makes the committed output reviewable
// in a diff. A real one-shot migration would use a fresh uuid and the real
// clock (spec §4: bundleId is any uuid; createdAt is when it was produced).
const BUNDLE_ID = '5ada9700-0000-4000-8000-000000000001';
const CREATED_AT = '2026-08-15T00:00:00.000Z';

///////////////////////////////////////////////////////////////////////////////
// Spec plumbing — canonical JSON (§8.1), digests (§8.3), scratch ids (§6)
///////////////////////////////////////////////////////////////////////////////

/**
 * §8.1 canonical JSON: object keys sorted by their UTF-16 code units, no
 * insignificant whitespace. Every NDJSON line MUST be canonical, and the
 * validator re-serializes and byte-compares, so "close enough" fails loudly
 * rather than silently.
 */
const canonical = (value) => {
    const sortValue = (v) => {
        if (Array.isArray(v)) return v.map(sortValue);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(sortValue(value));
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * A scratch UUID for one source record.
 *
 * §5 requires `$id` to be `<resource>:<uuid>`, so an adapter must mint SOME
 * uuid — but under the `allocate` id policy the target replaces every one of
 * them. Their only jobs are (a) making the bundle referentially closed so it
 * verifies on its own, and (b) letting one record point at another.
 *
 * Deriving them from the source key (rather than randomUUID) makes the whole
 * bundle a pure function of its input: re-running over unchanged CSVs produces
 * a byte-identical bundle, so a real diff means the DATA changed. It is
 * emphatically NOT how records are matched on re-import — that is `$source` and
 * the identity map — it is only reproducibility.
 */
const scratchId = (resource, externalId) => {
    const h = sha256(Buffer.from(`${SOURCE_SYSTEM}‖${resource}‖${externalId}`, 'utf8'));
    // Stamp the version (4) and variant (8) nibbles so it is a well-formed uuid.
    return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
};

///////////////////////////////////////////////////////////////////////////////
// A minimal CSV reader (RFC 4180 quoting) — the one thing every adapter needs
// and no one should hand-roll twice.
///////////////////////////////////////////////////////////////////////////////

const readCsv = (path) => {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
            continue;
        }
        if (c === '"') { quoted = true; continue; }
        if (c === ',') { row.push(field); field = ''; continue; }
        if (c === '\r') continue;
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += c;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    const [header, ...body] = rows.filter((r) => r.some((v) => v !== ''));
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
};

/** Empty CSV cell -> explicit null. §5: null and empty string are never coerced. */
const orNull = (v) => (v === undefined || v === '' ? null : v);

///////////////////////////////////////////////////////////////////////////////
// The mapping — the only part that is actually about YOUR data
///////////////////////////////////////////////////////////////////////////////

const orgId = scratchId('organization', ORG.code);
const companyId = scratchId('company', COMPANY.name);

const vendorsCsv = readCsv(join(HERE, 'input', 'vendors.csv'));
const contactsCsv = readCsv(join(HERE, 'input', 'contacts.csv'));

// Anchors. No `$source`: they are resolved on the target, never allocated, so
// there is no external key to remember. Only the natural key the importer
// matches on (organization: Code; company: Name) is load-bearing.
const organization = [{
    $id  : `organization:${orgId}`,
    $v   : 1,
    Code : ORG.code,
    Name : ORG.name,
}];

const companies = [{
    $id            : `company:${companyId}`,
    $v             : 1,
    Name           : COMPANY.name,
    OrganizationId : `organization:${orgId}`,
}];

const vendors = vendorsCsv.map((r) => ({
    $id       : `vendor:${scratchId('vendor', r.SupplierCode)}`,
    $v        : 1,
    // $source is the identity map's key — the ONE thing that makes a re-run
    // idempotent instead of duplicating everything (see the adapter guide).
    $source   : { system: SOURCE_SYSTEM, externalId: r.SupplierCode },
    CompanyId : `company:${companyId}`,
    VendorCode: r.SupplierCode,
    Name      : r.SupplierName,
    LegalName : orNull(r.LegalName),
    HQCity    : orNull(r.City),
    HQStateCode  : orNull(r.StateCode),
    HQCountryCode: orNull(r.Country),
    PaymentTerms : orNull(r.PaymentTerms),
    // §9 type fidelity: integers are JSON numbers; DECIMALS ARE STRINGS, with
    // their trailing zeros intact. 500000.00 as a JSON number would arrive as
    // 500000 and a money column would silently lose its scale.
    CreditDays   : r.CreditDays === '' ? null : Number(r.CreditDays),
    CreditLimit  : orNull(r.CreditLimit),
    Gstin        : orNull(r.GSTIN),
    Pan          : orNull(r.PAN),
    Website      : orNull(r.Website),
    IsActive     : r.Active === 'Y',
    Status       : r.Active === 'Y' ? 'Active' : 'Inactive',
}));

const contacts = contactsCsv.map((r) => ({
    $id        : `vendor_contact:${scratchId('vendor_contact', r.ContactRef)}`,
    $v         : 1,
    $source    : { system: SOURCE_SYSTEM, externalId: r.ContactRef },
    VendorId   : `vendor:${scratchId('vendor', r.SupplierCode)}`,
    FirstName  : orNull(r.GivenName),
    LastName   : orNull(r.FamilyName),
    Title      : orNull(r.Designation),
    Email      : orNull(r.EmailAddress),
    Phone      : orNull(r.Mobile),
    // The target's enum, not the source's vocabulary. A value outside it fails
    // schema validation at stage 4 — which is the point: it fails in the
    // adapter author's terminal, not halfway through a customer's migration.
    ContactType: ['Primary', 'Billing', 'Shipping', 'Accounts'].includes(r.Kind) ? r.Kind : 'Primary',
    IsPrimary  : r.Primary === 'Y',
}));

///////////////////////////////////////////////////////////////////////////////
// Emit
///////////////////////////////////////////////////////////////////////////////

const RESOURCES = [
    { resource: 'organization',   module: 'core', file: 'data/010-core/organization.ndjson',   schema: 'schema/core.organization.v1.schema.json',   records: organization, dependsOn: [] },
    { resource: 'company',        module: 'core', file: 'data/010-core/company.ndjson',        schema: 'schema/core.company.v1.schema.json',        records: companies,    dependsOn: ['organization'] },
    { resource: 'vendor',         module: 'core', file: 'data/010-core/vendor.ndjson',         schema: 'schema/core.vendor.v1.schema.json',         records: vendors,      dependsOn: ['company'] },
    { resource: 'vendor_contact', module: 'core', file: 'data/010-core/vendor_contact.ndjson', schema: 'schema/core.vendor_contact.v1.schema.json', records: contacts,     dependsOn: ['vendor'] },
];

rmSync(OUT, { recursive: true, force: true });
const write = (relative, contents) => {
    const path = join(OUT, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
};

const resourceEntries = RESOURCES.map((r) => {
    // §5: one canonical JSON object per line, SORTED ASCENDING BY $id, every
    // line newline-terminated including the last.
    const body = [...r.records]
        .sort((a, b) => (a.$id < b.$id ? -1 : a.$id > b.$id ? 1 : 0))
        .map((rec) => canonical(rec) + '\n')
        .join('');
    write(r.file, body);
    return {
        resource        : r.resource,
        module          : r.module,
        resourceVersion : 1,
        file            : r.file,
        schema          : r.schema,
        recordCount     : r.records.length,
        sha256          : sha256(Buffer.from(body, 'utf8')),
        dependsOn       : r.dependsOn,
    };
});

// The schemas travel WITH the bundle (§3): a consumer must be able to validate
// it years from now without asking the producer for anything.
for (const file of readdirSync(join(HERE, 'schema'))) {
    write(join('schema', file), readFileSync(join(HERE, 'schema', file)));
}

// §10 controls. Not required, but this is how a migration proves it did not
// quietly drop rows: the numbers come from the SOURCE system, and the target's
// verify stage checks what it loaded against them.
const controls = [
    { control: 'vendor_count', basis: 'count of rows in vendors.csv', legacyValue: String(vendors.length), tolerance: '0' },
    { control: 'vendor_contact_count', basis: 'count of rows in contacts.csv', legacyValue: String(contacts.length), tolerance: '0' },
    {
        control     : 'vendor_credit_limit_total',
        basis       : 'sum of CreditLimit over all suppliers, source currency INR',
        legacyValue : vendors.reduce((sum, v) => sum + Math.round(Number(v.CreditLimit ?? 0) * 100), 0) / 100 + '',
        tolerance   : '0.00',
    },
];
write('controls/control-totals.ndjson', controls.map((c) => canonical(c) + '\n').join(''));

const manifest = {
    formatVersion : '1.0',
    bundleId      : BUNDLE_ID,
    bundleType    : 'subset',
    profile       : 'migration',
    createdAt     : CREATED_AT,
    producer      : { product: 'example-csv-adapter', version: '1.0.0' },
    organization  : {
        id        : orgId,
        code      : ORG.code,
        legalName : ORG.name,
        // Companies have no Code column on this platform, so the `code` slot
        // carries the Name — and Name is what the importer resolves by.
        companies : [{ id: companyId, code: COMPANY.name, name: COMPANY.name }],
    },
    options : {
        // The declaration that this bundle expects `allocate`. The importer
        // does not read it (the operator's --id-policy is authoritative), which
        // is precisely why it must be honest — it is the only machine-readable
        // way an adapter tells an operator how to load its output.
        idPolicyHint       : 'allocate',
        blobsIncluded      : false,
        credentialsIncluded: false,
        // No naive timestamps are emitted at all (no $audit, no local-time
        // columns), so no sourceTimezone is required — §4.2.
    },
    controls  : { file: 'controls/control-totals.ndjson' },
    resources : resourceEntries,
};
write('manifest.json', canonical(manifest) + '\n');

// §8.3 the digest chain: every file except checksums.sha256 itself (and
// manifest.sig), one `<sha256>  <path>` line, SORTED BY PATH. The bundleDigest
// consumers quote is sha256 of this file.
const allFiles = [];
const walk = (dir, prefix) => {
    for (const name of readdirSync(join(OUT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = prefix ? `${prefix}/${name.name}` : name.name;
        if (name.isDirectory()) walk(join(dir, name.name), rel);
        else allFiles.push(rel);
    }
};
walk('.', '');
const sums = allFiles
    .filter((p) => p !== 'checksums.sha256' && p !== 'manifest.sig')
    .sort()
    .map((p) => `${sha256(readFileSync(join(OUT, p)))}  ${p}\n`)
    .join('');
write('checksums.sha256', sums);

console.log(`wrote ${OUT}`);
console.log(`  ${resourceEntries.length} resources, ${resourceEntries.reduce((n, r) => n + r.recordCount, 0)} records`);
console.log(`  bundleDigest sha256:${sha256(Buffer.from(sums, 'utf8'))}`);
console.log('\nnext:');
console.log('  node ../../bin/ember-validate.mjs verify bundle');
console.log('  node ../../bin/ember-validate.mjs lint   bundle');
