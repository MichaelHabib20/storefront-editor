/** Static AI config and the per-store ledger (reserve → settle, refunds, months, limits). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AiConfigError, createAiConfig, loadAiConfig } from '../src/ai-config.mjs';
import { createLedger } from '../src/ledger.mjs';

const defaults = {
  editModel: 'claude-sonnet-5-5',
  triageModel: 'claude-haiku-4-5-20251001',
  allowedModels: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  routing: 'fixed',
  effort: 'medium',
  monthlyLimitUsd: 10,
  perRequestMaxUsd: 2,
  minToStartUsd: 0.1,
  warnAt: 0.8,
  maxTurns: 40,
  maxFixRounds: 3,
};

function ledgerWith(stores = {}, clock = { date: new Date('2026-10-06T10:00:00Z') }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');
  const aiConfig = createAiConfig({ defaults, stores });
  return { ledger: createLedger({ file, aiConfig, now: () => clock.date }), aiConfig, clock, file };
}

test('the shipped config file is valid', () => {
  const config = loadAiConfig(new URL('../config/ai.json', import.meta.url));
  assert.ok(config.forStore('any').allowedModels.includes(config.forStore('any').editModel));
});

test('a store override replaces only the fields it names', () => {
  const config = createAiConfig({ defaults, stores: { big: { monthlyLimitUsd: 100, editModel: 'claude-opus-5-5' } } });
  assert.equal(config.forStore('big').monthlyLimitUsd, 100);
  assert.equal(config.forStore('big').editModel, 'claude-opus-5-5');
  assert.equal(config.forStore('big').perRequestMaxUsd, 2);
  assert.equal(config.forStore('small').monthlyLimitUsd, 10);
});

test('a model outside the allowed list is rejected, and routing never leaves the list', () => {
  assert.throws(() => createAiConfig({ defaults: { ...defaults, editModel: 'gpt-x' } }), AiConfigError);
  assert.throws(() => createAiConfig({ defaults, stores: { a: { editModel: 'claude-fable-5-1' } } }), AiConfigError);
  assert.throws(() => createAiConfig({ defaults: { ...defaults, monthlyLimitUsd: -1 } }), AiConfigError);

  const fixed = createAiConfig({ defaults });
  assert.equal(fixed.editModel('a', { large: true }), 'claude-sonnet-5-5');
  const auto = createAiConfig({ defaults: { ...defaults, routing: 'auto' } });
  assert.equal(auto.editModel('a', { large: true }), 'claude-opus-5-5');
  assert.equal(auto.editModel('a', { large: false }), 'claude-sonnet-5-5');
});

test('reserve holds the per-request max, settle charges the actual cost', () => {
  const { ledger } = ledgerWith();
  const reservation = ledger.reserve('acme');
  assert.equal(reservation.amountUsd, 2);
  assert.equal(ledger.status('acme').remainingUsd, 8);
  assert.equal(ledger.status('acme').busy, true);

  const after = ledger.settle(reservation, [
    { runId: 'r1', kind: 'triage', model: 'claude-haiku-4-5-20251001', costUsd: 0.01 },
    { runId: 'r1', kind: 'edit', model: 'claude-sonnet-5-5', costUsd: 0.74, usage: { inputTokens: 1000 } },
  ]);
  assert.equal(after.spentUsd, 0.75);
  assert.equal(after.remainingUsd, 9.25);
  assert.equal(after.busy, false);
  assert.equal(ledger.lines('acme').length, 2);
});

test('one run at a time per store; other stores are independent', () => {
  const { ledger } = ledgerWith();
  const first = ledger.reserve('acme');
  assert.throws(() => ledger.reserve('acme'), { code: 'busy' });
  ledger.reserve('other');
  ledger.release(first);
  ledger.reserve('acme');
});

test('the last reservation is what is left, then edits are blocked', () => {
  const { ledger } = ledgerWith();
  ledger.settle(ledger.reserve('acme'), [{ runId: 'r1', kind: 'edit', costUsd: 9.5 }]);
  const status = ledger.status('acme');
  assert.equal(status.warn, true);
  assert.equal(status.blocked, false);
  assert.equal(ledger.reserve('acme').amountUsd, 0.5);
});

test('blocked when less than the minimum is left; a refund unblocks', () => {
  const { ledger } = ledgerWith();
  ledger.settle(ledger.reserve('acme'), [{ runId: 'r1', kind: 'edit', costUsd: 9.95 }]);
  assert.equal(ledger.status('acme').blocked, true);
  assert.throws(() => ledger.reserve('acme'), { code: 'out_of_budget' });

  ledger.refund('acme', 'r1', 1, 'checks failed');
  assert.equal(ledger.status('acme').spentUsd, 8.95);
  assert.equal(ledger.status('acme').blocked, false);
});

test('a new month starts from zero', () => {
  const clock = { date: new Date('2026-10-31T23:00:00Z') };
  const { ledger } = ledgerWith({}, clock);
  ledger.settle(ledger.reserve('acme'), [{ runId: 'r1', kind: 'edit', costUsd: 9.99 }]);
  assert.equal(ledger.status('acme').blocked, true);
  clock.date = new Date('2026-11-01T00:30:00Z');
  assert.equal(ledger.status('acme').spentUsd, 0);
  assert.equal(ledger.status('acme').blocked, false);
});

test('a settled reservation cannot be settled twice; negative charges are refused', () => {
  const { ledger } = ledgerWith();
  const reservation = ledger.reserve('acme');
  assert.throws(() => ledger.settle(reservation, [{ runId: 'r', kind: 'edit', costUsd: -1 }]), { code: 'invalid_charge' });
  ledger.settle(reservation, []);
  assert.throws(() => ledger.settle(reservation, []), { code: 'no_reservation' });
});
