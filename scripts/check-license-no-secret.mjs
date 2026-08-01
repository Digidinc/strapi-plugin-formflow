#!/usr/bin/env node
/**
 * Tripwire: the license adapter must ship no seller secret.
 *
 * The plugin runs on the CUSTOMER's own server, so any credential baked into the
 * published package is a credential we have given away. The Freemius
 * customer-portal license endpoints are unauthenticated by design, so the adapter
 * needs no seller token at all — this guard fails the build if one ever creeps in.
 *
 * Deliberately a single-file, dependency-free check: it greps the one module where
 * license HTTP is allowed to live. It matches a real header/secret ASSIGNMENT, not
 * the mere mention of a word, so prose in comments does not trip it.
 */
import { readFileSync } from 'node:fs';

const TARGET = 'server/src/ee/license/mor-client.ts';

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (error) {
  console.error(`[check:license] FAIL: cannot read ${TARGET}: ${error.message}`);
  process.exit(1);
}

const bad = [];
// Catches both quoted and unquoted keys, e.g. `headers: { Authorization: ... }`.
if (/\bAuthorization\b\s*:/.test(src)) bad.push('sets an authorization header');
if (/(secret[_-]?key|bearer[_-]?token|access[_-]?token)\s*[:=]/i.test(src)) {
  bad.push('assigns a secret/token');
}
if (/process\.env\.[A-Z_]*SECRET/i.test(src)) bad.push('reads a *SECRET* env var');

if (bad.length) {
  console.error(`[check:license] FAIL: ${TARGET} ${bad.join('; ')}.`);
  process.exit(1);
}

console.log('[check:license] OK — no seller secret in the license adapter.');
