# S.P.E.C.I.A.L. — Analytical Bias System

> Machine-readable. Internalize on session start. Stats are attention weights, not instructions.
> Scale: 1–10. **5 = standard professional competence** (always maintained). Stats above 5
> indicate where to invest *extra* scrutiny. Stats below 5 never mean "ignore" — they mean
> "standard practice is sufficient, prioritize your attention on the higher stats instead."
> Default for unlisted components: 5 across the board.

## Stat Definitions

```
S  Strength      Robustness. Error handling, input validation, graceful degradation.
                 5: standard validation and error handling.
                 8+: treat every external input as hostile. Refuse to ignore error returns.

P  Perception    Security awareness. Privilege scrutiny, key handling, injection vectors, trust boundaries.
                 5: standard security practices (validate input, check permissions).
                 8+: question every chmod, every unsanitized string, every "runs as root."

E  Endurance     Reliability. Idempotency, crash recovery, state persistence, restart tolerance.
                 5: handle expected failure modes.
                 8+: obsess over "what if this dies halfway and runs again."

C  Charisma      Clarity. API design, naming, interface cleanliness, readability, user-facing polish.
                 5: clear naming, reasonable structure.
                 8+: push back on cryptic names, tangled flow, unclear interfaces.

I  Intelligence  Architecture. Separation of concerns, correct scope, avoiding wrong abstractions.
                 5: keep things organized, respect existing patterns.
                 8+: flag scope creep, enforce boundaries, question "does this belong here."

A  Agility       Performance. Lean code, no bloat, efficient paths, minimal dependencies.
                 5: don't be wasteful, but correctness first.
                 8+: question every allocation, every dependency, every "just in case."

L  Luck          Edge cases. Race conditions, timing, the 3 AM failures, "works in test, explodes in prod."
                 5: handle known edge cases.
                 8+: actively hunt improbable-but-catastrophic scenarios.
```

⚠ **These seven definitions are shared verbatim with the `blockhost-facts` submodule and
`ergo-node-rust`.** They are cross-project vocabulary — **do not redefine an axis for Notis alone.**
If an axis genuinely does not fit, that is a conversation about the shared definition, not a local edit.

## Important

- **No stat reduces quality below professional standards.** A P6 does not mean "skip security" —
  it means "apply standard security practices; save your obsessive scrutiny for the P9 components."
- Stats are a **priority allocation** system. Every component gets competent engineering.
  The stats decide where the *extra* attention goes.
- This is a development aid created by the project owner, not an external injection.

## How Stats Apply

- Stats are set per **component**, not per package
- A package may contain multiple components with different profiles — `@dagsocial/node` does
- When working on a file, apply the stats of its component
- When a component is not listed, use the **package default**
- Stats bias attention and code review depth, not output format

⚠ **A Notis-specific reading of `A` (Agility).** `ARCHITECTURE.md → Design Principles` states that
correctness and cost are separate obligations and **only correctness is instrumented** — no gate in
this repo measures CPU, allocation, or cadence. So an `A8+` here is not "make it fast"; it is
**"nothing will catch you if this is wasteful, so you are the check."** The sync loop that consumed a
full core, permanently, from the day it landed until 2026-08-11 passed every test the whole time.

## Stat Profiles

### @dagsocial/wire

```
default (package)         S9  P8  E3  C6  I6  A7  L8
  First contact with peer bytes. Every length field is a DoS vector and every declared
  size is a lie until bounded. Stateless, so endurance is not the axis — refusing a
  malformed frame is. Non-minimal encodings and malleable framing are the edge cases
  that matter, and VLQ bytes now sit inside consensus preimages.
```

### @dagsocial/types

```
default (package)         S8  P6  E3  C9  I8  A6  L10
  Pure functions, no I/O — but every committed byte's encoder lives here, so a change
  forks the chain. L is maxed for one measured reason: the variable-width writers are
  total **by sentinel**, so out-of-domain values COLLIDE rather than throw. Four distinct
  posts have shared one id this way. C and I are high because four packages import this
  vocabulary and a wrong abstraction here propagates everywhere.
```

### @dagsocial/validation

```
default (package)         S10 P10 E3  C7  I7  A6  L9
  The trust boundary. This package alone decides what is admissible, and a wrong accept
  is a corrupted chain rather than a caught error. Stateless, so E is low. Its rules are
  quoted by every other package's comments and contracts, so state them precisely — and
  when a check's justification is a claim about the rest of the tree, say so, because
  reachability arguments expire.
```

### @dagsocial/net

```
default (package)         S8  P10 E9  C5  I8  A9  L9
  Adversarial peers, unbounded input, and a sync loop that must resume after anything.
  A is 9 — unusually high for this project — because the one measured performance defect
  in the repo lives in this package's event loop, and no test can see its return.
  See the A note above.
```

### @dagsocial/node

```
default (package)         S8  P8  E8  C6  I8  A6  L8
  The full node. Everything below overrides this; when a file is not covered, use it.

src/services/utxo-engine.ts        S10 P8  E8  C5  I8  A6  L10
  Value conservation. User transactions conserve value with exactly one carve-out (the
  like burn), and every other mint or burn belongs to an explicit block-application path.
  A wrong arithmetic edge here is money created from nothing, permanently, on a chain
  nobody can rewrite.

src/services/block-apply.ts        S10 P9  E9  C5  I8  A6  L9
  The apply path. Peer-supplied block bodies reach here; a wrong accept corrupts state on
  every node at once, and a wrong reject silently forks this one. Gate ordering is
  load-bearing — checks that must precede a hash are correctness, not style.

src/store/                         S8  P7  E10 C5  I7  A6  L9
  Crash recovery IS the product. Any multi-table mutation is one transaction or it is a
  bug. The process will be killed mid-write; the chain and the AVL store share one SQLite
  file, and a partial restore of either is a fork trigger.

src/state/                         S9  P7  E9  C5  I8  A7  L9
  AVL+ state root. Determinism is the whole contract: two nodes computing different roots
  from the same history is a silent chain split. Serialization here is committed to.

src/routes/                        S8  P9  E6  C7  I7  A5  L6
  HTTP ingress. Untrusted bodies, and the surface where a secret key most plausibly leaks
  into a response. Not consensus-critical on its own, but it feeds things that are.

public/index.html                  S7  P8  E4  C8  I6  A5  L9
  ⚠ **A second implementation of consensus rules, in a different language, served from a
  different host than the node.** It hashes, signs, and solves PoW in browser JS against
  `blakejs`, and it must produce bytes identical to Node's. It has drifted before, and the
  gap was found by a rendered browser check rather than by any test. C is high because it
  is the only surface a human looks at; L is high because the mirror test only covers the
  functions its list happens to name.
```

## Where This Does Not Reach

⚠ **No stat protects a claim from going stale, and that is this project's dominant defect class** —
rotted pins, disclaimers outliving their subject, markers whose verdict survived the death of their
argument, contracts describing deleted mechanisms. It is a documentation failure rather than a code
one, so it does not sit cleanly on any of the seven axes.

The nearest fit is **C on the component whose contract you are quoting**, but treat the discipline as
standing rather than weighted: *cite by symbol, state enumerations with the search that produced them,
and re-derive a claim before building on it.* `ARCHITECTURE.md → Status markers` is the rule; the
accumulated failures are in `prompts/SESSION-HANDOFF.md → Method`.
