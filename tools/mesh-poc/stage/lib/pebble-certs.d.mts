export function generateStageCerts(opts: {
  outDir: string;
  pebbleIp: string;
}): Promise<{
  caPath: string;
  caKeyPath: string;
  serverCertPath: string;
  serverKeyPath: string;
}>;
