import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConfig, unlockConfig } from '../services/vault.ts';

test('vault encrypts API keys and decrypts them only with the password', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');
  const config = {
    port: 3456,
    requestDelayMs: 0,
    apiKeys: ['nvapi-secret-one', 'nvapi-secret-two'],
    selectedModel: 'moonshotai/kimi-k2.6'
  };

  saveConfig(filePath, 'minha-senha', config);
  const raw = readFileSync(filePath, 'utf8');

  assert.doesNotMatch(raw, /nvapi-secret/);
  assert.deepEqual(unlockConfig(filePath, 'minha-senha'), config);
  assert.throws(() => unlockConfig(filePath, 'senha-errada'));
});

test('vault defaults old configs to zero ms request delay', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', {
    port: 3456,
    requestDelayMs: 2500,
    apiKeys: ['nvapi-secret-one']
  });
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.requestDelayMs;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(unlockConfig(filePath, 'minha-senha').requestDelayMs, 0);
});

test('vault migrates the old 2500 ms default to zero for smooth RPM mode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', {
    port: 3456,
    requestDelayMs: 2500,
    apiKeys: ['nvapi-secret-one']
  });
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.rateLimitMode;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(unlockConfig(filePath, 'minha-senha').requestDelayMs, 0);
});
