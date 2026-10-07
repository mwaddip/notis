// The command line's entry: argv in, `textLines` or `toJson` out, exit code
// from `runCli`. The run and its JSON shape live in `src/cli.ts`.

import { parseConfig, ConfigError } from './config.js';
import { postCommandLines, textLines } from './text.js';
import { runCli, toJson } from './cli.js';
import type { CliResult } from './cli.js';
import type { Config } from './config.js';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  const result = await runCli(config, globalThis.fetch, Date.now);
  output(config, result);
  process.exit(result.exitCode);
}

function output(config: Config, result: CliResult): void {
  if (config.json) {
    process.stdout.write(JSON.stringify(toJson(result), null, 2) + '\n');
  } else if (result.post !== null) {
    process.stdout.write(postCommandLines(result.post).join('\n') + '\n');
  } else {
    process.stdout.write(textLines(result.tip, result.run).join('\n') + '\n');
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
