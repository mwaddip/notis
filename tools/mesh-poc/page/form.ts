// MESH_INTERFACE → Discovery → "A node added by hand" — the reader
// adds a node by its key and an address. The form carries a key
// field, an address field and a `trust this node` checkbox (checked
// by default), and calls `client.addByHand(key, [address], trusted)`
// on submit. A `MeshConfigError` is shown under the form in words
// (through `textContent`), the fields kept; a success clears them.
//
// The form lives outside the state renderer's subtree (the probe's
// sibling pattern): it is a direct child of the root beside
// `[data-role="state-root"]`, so a render replaces only the state
// subtree and leaves the form untouched.

import type { MeshClient } from '../src/client/mesh-client.js';
import { MeshConfigError } from '../src/config.js';

export interface AttachHandFormOptions {
  root: HTMLElement;
  client: Pick<MeshClient, 'addByHand'>;
}

export function attachHandForm(opts: AttachHandFormOptions): void {
  const form = document.createElement('form');
  form.setAttribute('data-role', 'hand-form');

  const keyLabel = document.createElement('label');
  keyLabel.setAttribute('for', 'hand-form-key');
  keyLabel.textContent = 'key';
  const keyInput = document.createElement('input');
  keyInput.id = 'hand-form-key';
  keyInput.name = 'key';
  keyInput.type = 'text';

  const addrLabel = document.createElement('label');
  addrLabel.setAttribute('for', 'hand-form-address');
  addrLabel.textContent = 'address';
  const addrInput = document.createElement('input');
  addrInput.id = 'hand-form-address';
  addrInput.name = 'address';
  addrInput.type = 'text';

  const trustInput = document.createElement('input');
  trustInput.id = 'hand-form-trusted';
  trustInput.name = 'trusted';
  trustInput.type = 'checkbox';
  trustInput.checked = true;
  const trustLabel = document.createElement('label');
  trustLabel.setAttribute('for', 'hand-form-trusted');
  trustLabel.textContent = 'trust this node';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';

  form.appendChild(keyLabel);
  form.appendChild(keyInput);
  form.appendChild(addrLabel);
  form.appendChild(addrInput);
  form.appendChild(trustInput);
  form.appendChild(trustLabel);
  form.appendChild(addBtn);

  function clearError(): void {
    const prev = form.querySelector('[data-role="form-error"]');
    if (prev !== null) prev.remove();
  }

  function showError(message: string): void {
    clearError();
    const err = document.createElement('div');
    err.setAttribute('data-role', 'form-error');
    err.textContent = message;
    form.appendChild(err);
  }

  addBtn.addEventListener('click', () => {
    const key = keyInput.value;
    const address = addrInput.value;
    const trusted = trustInput.checked;
    try {
      opts.client.addByHand(key, [address], trusted);
    } catch (e) {
      if (e instanceof MeshConfigError) {
        showError(e.message);
        return;
      }
      throw e;
    }
    // A success clears the fields and any prior error.
    clearError();
    keyInput.value = '';
    addrInput.value = '';
    trustInput.checked = true;
  });

  opts.root.appendChild(form);
}
