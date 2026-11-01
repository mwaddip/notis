export declare class FaultLog {
  constructor(opts: { dryRun: boolean; scenario: string });
  readonly dryRun: boolean;
  readonly scenario: string;
  readonly records: string[];
  readonly removals: Array<{ name: string; argv: string[]; restart?: boolean }>;
  apply(name: string, argv: string[], removalArgv: string[] | null): void;
  signal(name: string, pid: number, opts?: { restartArgv?: string[] | null }): void;
  spawn(name: string, argv: string[]): void;
  remove(name: string): boolean;
  removeAll(): void;
}
export declare function assertStagePrivileged(argv: unknown): void;
