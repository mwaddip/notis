// TEST_STATE_INTERFACE → Generation → "The faucet's credits stand in one box
// made by the state's last write".
//
// The judgement the generator applies after the grant: the faucet's current
// holdings on A, beside the box ids it held before the grant. The faucet's
// credits stand in exactly one box, and that box is absent from the pre-grant
// set — the grant's change box.

export interface FaucetGrantHoldingsInput {
  readonly preGrantBoxIds: readonly string[];
  readonly currentBoxIds: readonly string[];
}

export type FaucetGrantHoldingsVerdict =
  | { readonly ok: true; readonly grantBoxId: string }
  | { readonly ok: false; readonly reason: string };

export function judgeFaucetGrantHoldings(
  input: FaucetGrantHoldingsInput,
): FaucetGrantHoldingsVerdict {
  const current = input.currentBoxIds;
  if (current.length !== 1) {
    return {
      ok: false,
      reason:
        `the faucet holds ${current.length} credit box(es), not one: [${current.join(', ')}]`,
    };
  }
  const only = current[0]!;
  const pre = new Set(input.preGrantBoxIds);
  if (pre.has(only)) {
    return {
      ok: false,
      reason:
        `the faucet's one credit box ${only} is among the ${pre.size} box(es) it held before the grant`,
    };
  }
  return { ok: true, grantBoxId: only };
}
