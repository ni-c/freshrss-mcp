import { describe, expect, it } from 'vitest';

import { ConfirmationStore, setResourceKey } from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('rejects a call without a token and accepts the issued one once', () => {
    const store = new ConfirmationStore();
    const resource = setResourceKey('delete_item', ['a']);

    expect(store.consume(resource, undefined)).toBe(false);
    const token = store.issue(resource);
    expect(store.consume(resource, token)).toBe(true);
    // Single use: a replay must not work.
    expect(store.consume(resource, token)).toBe(false);
  });

  it('does not accept a token issued for a different target', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_item', ['a']));
    expect(store.consume(setResourceKey('delete_item', ['b']), token)).toBe(
      false
    );
  });

  it('does not accept a token issued for a smaller set of targets', () => {
    // The regression this guards: confirming ["a"] must not execute
    // ["a", "secrets"] — the model picks the second list.
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_files', ['a']));
    expect(
      store.consume(setResourceKey('delete_files', ['a', 'secrets']), token)
    ).toBe(false);
  });

  it('treats the target set as unordered', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_files', ['a', 'b']));
    expect(
      store.consume(setResourceKey('delete_files', ['b', 'a']), token)
    ).toBe(true);
  });

  it('expires tokens', async () => {
    const store = new ConfirmationStore(1);
    const resource = setResourceKey('delete_item', ['a']);
    const token = store.issue(resource);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.consume(resource, token)).toBe(false);
  });
});
