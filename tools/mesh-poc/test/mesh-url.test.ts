import { describe, it, expect } from 'vitest';
import { MeshUrlError, meshBaseUrl, parseMeshUrl, idOfMeshUrl } from '../src/mesh-url.js';

const id = 'ab'.repeat(32); // 64 lowercase hex

describe('mesh-url', () => {
  it('the mesh URL round-trips with path and query', () => {
    const url = meshBaseUrl(id) + '/nipopow/proof/24/20?x=1';
    expect(parseMeshUrl(url)).toEqual({ notisId: id, path: '/nipopow/proof/24/20?x=1' });
  });

  it('a non-mesh scheme is refused', () => {
    expect(() => parseMeshUrl('https://' + id + '/x')).toThrow(MeshUrlError);
  });

  it('uppercase hex in the host is refused', () => {
    expect(() => parseMeshUrl('notis-mesh://' + 'AB'.repeat(32) + '/x')).toThrow(MeshUrlError);
  });

  it('a missing path is refused', () => {
    expect(() => parseMeshUrl('notis-mesh://' + id)).toThrow(MeshUrlError);
  });

  it('meshBaseUrl refuses a non-64-lowercase-hex id', () => {
    expect(() => meshBaseUrl('AB'.repeat(32))).toThrow(MeshUrlError);
    expect(() => meshBaseUrl('ab'.repeat(31))).toThrow(MeshUrlError);
  });

  describe('idOfMeshUrl', () => {
    it('reads the id from a URL with a path', () => {
      expect(idOfMeshUrl(meshBaseUrl(id) + '/blocks/current')).toBe(id);
    });

    it('reads the id from a bare base URL (no path)', () => {
      expect(idOfMeshUrl(meshBaseUrl(id))).toBe(id);
    });

    it('refuses a non-mesh scheme', () => {
      expect(() => idOfMeshUrl('https://' + id + '/x')).toThrow(MeshUrlError);
    });

    it('refuses uppercase hex', () => {
      expect(() => idOfMeshUrl('notis-mesh://' + 'AB'.repeat(32) + '/x')).toThrow(MeshUrlError);
    });

    it('refuses a short id', () => {
      expect(() => idOfMeshUrl('notis-mesh://' + 'ab'.repeat(31) + '/x')).toThrow(MeshUrlError);
    });
  });
});
