// The bridge's manifest match pattern derived from the build's `notis-public`
// — WEB_INTERFACE → The extension → "Permissions and policy, the whole list".
// Firefox drops a content-script match that carries a port (the install
// succeeds, `web-ext lint` is silent, the script never binds); a port-less
// pattern matches every port in both browsers.
//
// Pure ESM so both the emitter and vitest import it from the same source.

/** Return the manifest match pattern for the build's public base, or `null`
 *  when the base is empty (an empty base builds an extension with no bridge).
 *  Throws on a base that is not `http:` / `https:`, does not close with `/`,
 *  or carries a query or a fragment. */
export function matchPatternFor(publicBase) {
  if (publicBase === '') return null;
  const url = new URL(publicBase);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`matchPatternFor: unsupported protocol ${url.protocol}`);
  }
  if (!url.pathname.endsWith('/')) {
    throw new Error(`matchPatternFor: base must end with '/'`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`matchPatternFor: base must carry no query or fragment`);
  }
  return `${url.protocol}//${url.hostname}${url.pathname}p/*`;
}
