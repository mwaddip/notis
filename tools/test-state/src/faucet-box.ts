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
  _input: FaucetGrantHoldingsInput,
): FaucetGrantHoldingsVerdict {
  throw new Error('judgeFaucetGrantHoldings: not implemented');
}
