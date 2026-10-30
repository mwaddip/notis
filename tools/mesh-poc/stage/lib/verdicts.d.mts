export type Verdict = 'PASS' | 'FAIL' | 'skipped';

export function verdictS1Node(m: unknown): Verdict;
export function verdictS1Probe(m: unknown): Verdict;
export function verdictS1DnsSilent(m: unknown): Verdict;
export function verdictS2Priv1(m: unknown): Verdict;
export function verdictS2Priv2(m: unknown): Verdict;
export function verdictS3Moved(m: unknown): Verdict;
export function verdictS3Recovered(m: unknown): Verdict;
export function verdictS4Pub1UdpDrop(m: unknown): Verdict;
export function verdictS4AllUdpDrop(m: unknown): Verdict;
export function verdictS4Renewal(m: unknown): Verdict;
export function verdictS5(m: unknown): Verdict;
export function verdictS6NoAnchor(m: unknown): Verdict;
export function verdictS6Hostile(m: unknown): Verdict;
export function verdictS4InterNodeTcp(m: unknown): Verdict;
export function verdictIceServers(record: unknown): Verdict;
