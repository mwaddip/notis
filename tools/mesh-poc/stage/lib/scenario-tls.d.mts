export declare function parseIssuerSubject(output: string | Buffer): { issuer: string | null; subject: string | null };
export declare function readTlsIssuer(ns: string, host: string, port: number, opts?: { user?: string; timeoutMs?: number }): { issuer: string | null; subject: string | null };
