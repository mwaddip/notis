// The extension manifest's two derived hosts, each with its port dropped.
// `matchPatternFor` builds the bridge's content-script match from the build's
// `notis-public` —
// WEB_INTERFACE → The extension → "Permissions and policy, the whole list".
// `originPatternFor` builds the one optional host permission from the build's
// faucet base —
// WEB_INTERFACE → The extension → "The manifest".
// Firefox drops a content-script match that carries a port (the install
// succeeds, `web-ext lint` is silent, the script never binds); a port-less
// pattern matches every port in both browsers.
//
// Pure ESM so both the emitter and vitest import it from the same source.

function checkScheme(fn, url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fn}: unsupported protocol ${url.protocol}`);
  }
}

function checkNoQueryOrFragment(fn, url) {
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${fn}: base must carry no query or fragment`);
  }
}

/** Return the manifest match pattern for the build's public base, or `null`
 *  when the base is empty (an empty base builds an extension with no bridge).
 *  Throws on a base that is not `http:` / `https:`, does not close with `/`,
 *  or carries a query or a fragment. */
export function matchPatternFor(publicBase) {
  if (publicBase === '') return null;
  const url = new URL(publicBase);
  checkScheme('matchPatternFor', url);
  if (!url.pathname.endsWith('/')) {
    throw new Error(`matchPatternFor: base must end with '/'`);
  }
  checkNoQueryOrFragment('matchPatternFor', url);
  return `${url.protocol}//${url.hostname}${url.pathname}p/*`;
}

/** Return the optional-host match pattern for the build's faucet base, or
 *  `null` when the base is empty (an empty base declares no optional host).
 *  Drops the path and the port: the origin plus `/*`. Throws on a base that
 *  is not an absolute URL, is not `http:` / `https:`, or carries a query or
 *  a fragment. */
export function originPatternFor(base) {
  if (base === '') return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`originPatternFor: invalid URL`);
  }
  checkScheme('originPatternFor', url);
  checkNoQueryOrFragment('originPatternFor', url);
  return `${url.protocol}//${url.hostname}/*`;
}
