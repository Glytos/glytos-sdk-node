import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/index';

// A fixed vector produced by the server signer (HMAC-SHA256 over "{ts}.{body}"), so this
// SDK is proven byte-for-byte compatible with how Glytos signs deliveries.
const SECRET = 'whsec_test_secret';
const TS = '1710000000';
const BODY = '{"event":"call.completed","id":"evt_123"}';
const SIG = '356d865446082d49c6bfa57299c45900ab0d6681363426341acbe7c8f07ba025';

const header = (ts: string, sig: string) => `t=${ts},v1=${sig}`;

describe('verifyWebhook', () => {
  it('accepts a known signature', () => {
    // Tolerance 0 so the fixed historical timestamp is not rejected as too old.
    expect(verifyWebhook(BODY, header(TS, SIG), SECRET, 0)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhook(`${BODY}x`, header(TS, SIG), SECRET, 0)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyWebhook(BODY, header(TS, SIG), 'wrong-secret', 0)).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhook(BODY, 'garbage', SECRET, 0)).toBe(false);
    expect(verifyWebhook(BODY, `t=${TS}`, SECRET, 0)).toBe(false);
  });

  it('rejects an expired delivery', () => {
    expect(verifyWebhook(BODY, header(TS, SIG), SECRET)).toBe(false);
  });

  it('accepts a fresh delivery', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = '{"hello":"world"}';
    const secret = 'whsec_live';
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(verifyWebhook(body, header(ts, sig), secret)).toBe(true);
  });
});
