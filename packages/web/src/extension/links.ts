// The links preference and the pending-record prefix — WEB_INTERFACE → The
// extension → "Links into the extension". Pure — no `chrome`, no DOM — because
// the bridge imports it too.

export const K_LINKS = 'notis.links';
export const K_OPEN_PREFIX = 'notis.open.';

export type LinksPref = 'site' | 'here';

export const LINKS_DEFAULT: LinksPref = 'here';

/** Read the stored value into the preference — `site` only for the string,
 *  the default for anything else (an absent value reads as the default). */
export function readLinksPref(raw: unknown): LinksPref {
  return raw === 'site' ? 'site' : LINKS_DEFAULT;
}
