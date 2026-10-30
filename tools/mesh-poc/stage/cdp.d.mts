export declare function listTargets(cdpUrl?: string): Promise<unknown>;
export declare function openTarget(url: string, cdpUrl?: string): Promise<{ id: string; webSocketDebuggerUrl: string }>;
export declare function closeTarget(targetId: string, cdpUrl?: string): Promise<void>;
export interface CdpSession {
  ready: Promise<void>;
  send(method: string, params?: object): Promise<unknown>;
  close(): void;
}
export declare function openSession(wsUrl: string, opts?: { timeoutMs?: number }): CdpSession;
export declare function evaluate(url: string, expression: string, opts?: { cdpUrl?: string; timeoutMs?: number; awaitPromise?: boolean }): Promise<unknown>;
export declare function pollEvaluate(url: string, expression: string, predicate: (v: unknown) => boolean, opts?: { cdpUrl?: string; timeoutMs?: number; pollMs?: number }): Promise<unknown>;
export interface CdpPage {
  target: { id: string; webSocketDebuggerUrl: string };
  eval(expression: string, opts?: { awaitPromise?: boolean; perCallTimeoutMs?: number }): Promise<unknown>;
  pollEval(expression: string, predicate: (v: unknown) => boolean, opts?: { timeoutMs?: number; pollMs?: number }): Promise<unknown>;
  close(): Promise<void>;
}
export declare function openPage(url: string, opts?: { cdpUrl?: string; timeoutMs?: number }): Promise<CdpPage>;
