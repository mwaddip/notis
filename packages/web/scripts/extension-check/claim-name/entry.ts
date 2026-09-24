// The web's own claim flow and the two clients it runs over, re-exported so
// vite can bundle them for Node — claim-name.mjs claims S's name through the
// code the extension's `claim` runs, never a copy (WEB_INTERFACE → The
// username row, → The wallet).
export { submitClaimFlow } from '../../../src/wallet/submit';
export { NodeClient } from '../../../src/api/client';
export { WriteClient } from '../../../src/api/write';
