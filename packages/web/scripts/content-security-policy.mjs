// WEB_INTERFACE → The client is served from the node's own origin →
// "The web build's shell carries its own security policy" — the meta's exact
// content stated here once, and the vite plugin that writes it into the shell
// a build emits, right after the shell's `<meta charset="utf-8">` and before
// `<base>`. `apply: 'build'` scopes the plugin to `vite build`: vite's dev
// server injects client styles as inline `<style>` elements, which the
// policy's `style-src 'self'` would block.

export const WEB_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src *; connect-src *; object-src 'none'; base-uri 'self'; form-action 'none'";

const META = `<meta http-equiv="Content-Security-Policy" content="${WEB_SECURITY_POLICY}">`;
const CHARSET_RE = /<meta charset="utf-8">/;
const POLICY_RE = /http-equiv=["']Content-Security-Policy["']/i;

function injectPolicy(html, filename) {
  const match = CHARSET_RE.exec(html);
  if (!match) {
    throw new Error(
      `web-security-policy: ${filename}: shell has no <meta charset="utf-8"> — the policy meta is written right after the charset tag, so the charset tag is the only valid anchor`,
    );
  }
  if (POLICY_RE.test(html)) {
    throw new Error(
      `web-security-policy: ${filename}: shell already carries a Content-Security-Policy meta — the policy has one source and one place`,
    );
  }
  const pos = match.index + match[0].length;
  return html.slice(0, pos) + '\n' + META + html.slice(pos);
}

/**
 * A vite plugin that writes the Content-Security-Policy meta into the shell
 * a build emits, right after `<meta charset="utf-8">`. `apply: 'build'`
 * scopes it to `vite build` — vite's dev server injects styles inline, which
 * the policy's `style-src 'self'` would block. The plugin throws, naming
 * the reason, when the shell has no charset tag or already carries a
 * Content-Security-Policy meta — so the policy has one source and one place.
 * WEB_INTERFACE → The client is served from the node's own origin →
 * "The web build's shell carries its own security policy"
 */
export function webSecurityPolicyPlugin() {
  return {
    name: 'web-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return injectPolicy(html, ctx.filename ?? ctx.path ?? '(shell)');
      },
    },
  };
}
