// WEB_INTERFACE → The client is served from the node's own origin →
// "The web build's shell carries its own security policy" — the policy
// string the web build's shell carries and the vite plugin that writes it.
// The real body lands with the plugin's registration in vite.config.ts.

export const WEB_SECURITY_POLICY = '';

/**
 * A vite plugin that writes the Content-Security-Policy meta into the shell
 * a web build emits.
 * WEB_INTERFACE → The client is served from the node's own origin →
 * "The web build's shell carries its own security policy"
 */
export function webSecurityPolicyPlugin() {
  return {
    name: 'web-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html;
      },
    },
  };
}
