# Ed25519 test vectors

Two third-party corpora, each byte-identical to its source at the commit named. The batch suite holds
`verifyEd25519Batch` to `verifyEd25519` over every vector in both (`contracts/VALIDATION_INTERFACE.md`
→ verifyEd25519Batch).

| File | Source | Commit | License |
|---|---|---|---|
| `ed25519_test.json` | Wycheproof's Ed25519 verification set — <https://raw.githubusercontent.com/C2SP/wycheproof/3fa63dd0344abb611f1fb1d77e119938603ea230/testvectors_v1/ed25519_test.json> | `C2SP/wycheproof` `3fa63dd0344abb611f1fb1d77e119938603ea230` | Apache-2.0 |
| `cases.json` | ed25519-speccheck's cases — <https://raw.githubusercontent.com/novifinancial/ed25519-speccheck/65519336fda78a3d016e947df6d82848aca0c9da/cases.json> | `novifinancial/ed25519-speccheck` `65519336fda78a3d016e947df6d82848aca0c9da` | Apache-2.0 |

Both projects are licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>).
