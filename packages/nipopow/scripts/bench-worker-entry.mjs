// tsup's bundling entry for the browser worker (bench-proof-m.mjs → buildWorkerBundle). Nothing else imports
// this file; it exists only so tsup has a real path to bundle from.
import { workerRun } from './bench-core.mjs';
workerRun();
