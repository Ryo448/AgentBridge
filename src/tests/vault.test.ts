import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INTERNAL_API_KEY } from '../config.ts';
import { localKeyStored, saveConfig, unlockConfig } from '../services/vault.ts';

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
  const unlocked = unlockConfig(filePath, 'minha-senha');
  assert.deepEqual(unlocked.apiKeys, config.apiKeys);
  assert.equal(unlocked.port, config.port);
  assert.equal(unlocked.selectedModel, config.selectedModel);
  assert.throws(() => unlockConfig(filePath, 'senha-errada'));
});

test('vault encrypts the local key and never writes it in plain text', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', {
    port: 3456,
    requestDelayMs: 0,
    apiKeys: ['nvapi-secret-one'],
    localApiKey: 'minha-chave-local'
  });
  const raw = readFileSync(filePath, 'utf8');

  assert.doesNotMatch(raw, /minha-chave-local/);
  assert.equal(localKeyStored(filePath), true);
  assert.equal(unlockConfig(filePath, 'minha-senha').localApiKey, 'minha-chave-local');
});

test('vault defaults the local key when the config has none (legacy)', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentbridge-vault-'));
  const filePath = path.join(directory, 'config.json');

  saveConfig(filePath, 'minha-senha', {
    port: 3456,
    requestDelayMs: 0,
    apiKeys: ['nvapi-secret-one']
  });
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  delete stored.localApiKey;
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  assert.equal(localKeyStored(filePath), false);
  assert.equal(unlockConfig(filePath, 'minha-senha').localApiKey, INTERNAL_API_KEY);
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
