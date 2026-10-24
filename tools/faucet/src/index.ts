import { loadConfig } from './config.js';
import { HttpNodeClient } from './node-client.js';
import { createApp, listenFaucet } from './server.js';

const cfg = loadConfig(process.env);
const app = createApp(cfg, new HttpNodeClient(cfg.nodeUrl, (url, init) => fetch(url, init)));
listenFaucet(app, cfg.port).on('listening', () => {
  // The public key identifies the faucet; the secret is never logged.
  console.log(
    `faucet listening on ${cfg.port} as ${cfg.publicKeyHex} ` +
    `against ${cfg.networkType} at ${cfg.nodeUrl}`,
  );
});
