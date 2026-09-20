import { describe, it, expect } from 'vitest';
import { sameManifestContent } from '../extension/manifest-content.mjs';

// WEB_INTERFACE → "The Firefox build ships signed as well" —
// `manifest.json` is compared by parsed content, since Mozilla's signing
// re-serialises it and the closing newline goes. Every rule has a passing
// and a throwing exemplar; each throw is asserted by a fragment of its
// message naming `sameManifestContent`.

describe('sameManifestContent', () => {
  it('equal texts return true', () => {
    const text = '{"name":"notis","version":"0.3.1"}';
    expect(sameManifestContent(text, text)).toBe(true);
  });

  it('the same text without its closing newline returns true', () => {
    const with_ = '{"name":"notis","version":"0.3.1"}\n';
    const without = '{"name":"notis","version":"0.3.1"}';
    expect(sameManifestContent(with_, without)).toBe(true);
  });

  it('reordered top-level keys return true', () => {
    const a = '{"name":"notis","version":"0.3.1"}';
    const b = '{"version":"0.3.1","name":"notis"}';
    expect(sameManifestContent(a, b)).toBe(true);
  });

  it('reordered keys at a nested depth return true', () => {
    const a = '{"browser_specific_settings":{"gecko":{"id":"extension@notis.fun","strict_min_version":"140.0"}}}';
    const b = '{"browser_specific_settings":{"gecko":{"strict_min_version":"140.0","id":"extension@notis.fun"}}}';
    expect(sameManifestContent(a, b)).toBe(true);
  });

  it('different whitespace between the same content returns true', () => {
    const a = '{"name":"notis","version":"0.3.1"}';
    const b = '{\n  "name": "notis",\n  "version": "0.3.1"\n}\n';
    expect(sameManifestContent(a, b)).toBe(true);
  });

  it('a changed value returns false', () => {
    const a = '{"name":"notis","version":"0.3.1"}';
    const b = '{"name":"notis","version":"0.3.2"}';
    expect(sameManifestContent(a, b)).toBe(false);
  });

  it('an added key returns false', () => {
    const a = '{"name":"notis"}';
    const b = '{"name":"notis","version":"0.3.1"}';
    expect(sameManifestContent(a, b)).toBe(false);
  });

  it('a removed key returns false', () => {
    const a = '{"name":"notis","version":"0.3.1"}';
    const b = '{"name":"notis"}';
    expect(sameManifestContent(a, b)).toBe(false);
  });

  it('a reordered array returns false', () => {
    const a = '{"permissions":["storage","tabs"]}';
    const b = '{"permissions":["tabs","storage"]}';
    expect(sameManifestContent(a, b)).toBe(false);
  });

  it('throws naming sameManifestContent on text that is not JSON', () => {
    expect(() => sameManifestContent('not json', '{}')).toThrow(/sameManifestContent/);
  });

  it('throws naming sameManifestContent on a JSON array', () => {
    expect(() => sameManifestContent('[1,2,3]', '{}')).toThrow(/sameManifestContent/);
  });

  it('throws naming sameManifestContent on JSON null', () => {
    expect(() => sameManifestContent('null', '{}')).toThrow(/sameManifestContent/);
  });

  it('throws naming sameManifestContent on a JSON primitive', () => {
    expect(() => sameManifestContent('42', '{}')).toThrow(/sameManifestContent/);
  });

  it('throws naming sameManifestContent when the second text is not JSON', () => {
    expect(() => sameManifestContent('{}', 'not json')).toThrow(/sameManifestContent/);
  });

  it('throws naming sameManifestContent when the second text is a JSON array', () => {
    expect(() => sameManifestContent('{}', '[]')).toThrow(/sameManifestContent/);
  });
});
