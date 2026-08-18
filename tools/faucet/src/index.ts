import { loadConfig } from './config.js';
import { HttpNodeClient } from './node-client.js';
import { createApp } from './server.js';

const cfg = loadConfig(process.env);
createApp(cfg, new HttpNodeClient(cfg.nodeUrl)).listen(cfg.port, () => {
  // The public key identifies the faucet; the secret is never logged.
  console.log(
    `faucet listening on ${cfg.port} as ${cfg.publicKeyHex} ` +
    `against ${cfg.networkType} at ${cfg.nodeUrl}`,
  );
});
