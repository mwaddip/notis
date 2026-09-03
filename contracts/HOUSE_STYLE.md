# House Style Contract

**Component:** cross-cutting — every human-facing surface
**Status:** implemented in full on `docs/site/*`; partially on the demo UI — see below
**Applies to:** `docs.notis.fun` (`docs/site/*`), `packages/node/public/index.html` (partial),
`@dagsocial/web`, any future product surface

> **`docs/site/*` implements this contract in full**, measured 2026-08-10: both token sets under
> the names used here, the inverse-styled theme control, the paint-don't-transition restore, all
> four mark tiers as inline SVG driven by `--notis-green` / `--notis-keyline`, and both faces
> self-hosted. Commits `944d16c`, `524e63d`, `0dc8ded`.
>
> ⚠ **This banner read "No surface implements this today" and described the docs site as dark
> phosphor-green with a CRT treatment.** The contract landed in `8c5c7ff` and the docs site was
> re-themed in `944d16c` — **the same day**. The disclaimer was false within hours of being
> written and stayed that way. Recorded rather than quietly corrected, because it is the second
> instance of a known failure: a marker asserting a fact about the tree decays when the tree
> moves, and a disclaimer creates a region nobody re-reads.

> **The demo UI (`packages/node/public/index.html`) is IN scope for colour, typography and
> motion** — changed 2026-08-10, having previously been excluded outright.
>
> The exclusion's ground was that the demo UI is scaffolding about to die when `@dagsocial/web`
> lands. It is the only browser surface that **writes** withdraw, invite, vouch and unvouch
> transactions — `@dagsocial/web` posts and likes, and does none of the rest — so it is what a
> human uses for those for an open-ended period. **A surface nobody will replace soon is not
> scaffolding.**
>
> **The inclusion is deliberately partial.** Layout, information architecture, interaction and
> illustration stay out — the demo UI keeps its own shell. `WEB_INTERFACE.md` also still holds:
> it gets no interface contract, no documented flows and no UX commitments. The claim here is
> narrow — that a surface humans look at should not be built out of the exact register "Why there
> is a house style at all" was written to avoid.

## Scope

Colour, typography, the mark, motion, interaction, spacing, illustration and voice. It does
not govern layout or information architecture, which belong to the surface implementing it.

## Why there is a house style at all

Notis is a free-speech platform, and the visual language of that category is almost uniformly
angry — dark grounds, hard reds, combat metaphors, edge as a posture. That is not incidental
decoration. **The look recruits the audience.** Build something that resembles a battleground
and it fills with people who came to fight, after which no moderation policy can save it.

So the design brief is a moderation instrument: calm, unity, safety, non-preachy,
non-ideological, and specifically *not* an interface that farms attention. Everything below
derives from that, and the reasoning is kept attached to each rule on purpose — a rule whose
justification has been stripped gets overridden by the first contributor who finds it
inconvenient.

## Principles

These generated everything else. When a case is not covered, decide from these.

1. **Saturation is the arousal dial.** Saturated colour raises attention whether or not you
   want it to. Holding saturation low is not only calmer, it is *structural*: nobody can
   build an attention-grabbing badge out of a colour that does not grab. This is the single
   cheapest guarantee against the interface being weaponised later.
2. **Mixed, not muted.** A colour desaturated toward grey is office carpet. Desaturated
   toward ochre or clay it becomes sap, moss, reseda — the same low arousal, far more
   character. Never reach for grey to calm something down.
3. **Yellow-ward, never saturated.** Every politically loaded green — flag, party, sectarian
   — is a *saturated* one. Nothing in this palette is on anyone's flag, and that is a
   requirement, not a coincidence. Corollary: never a bright green beside a bright orange at
   equal weight; that pairing is specifically the Irish sectarian one.
4. **Warm dark, not black.** The dark theme is bistre. No phosphor, no glow, no scanlines.
   That register codes crypto-libertarian-underground, which is the exact trap described
   above.
5. **One thing steps out of the grid per page.** Personality cannot live in saturation or
   motion here, because those are the attention-farming tools. It lives in material, type,
   voice, and a single deliberate departure per screen. The charm reads *because* the
   baseline is sober.
6. **Karma renders as standing, not score.** A word you hold, not a number you climb. This is
   the largest single lever on whether the place feels calm or competitive, and it is not a
   colour decision at all. See "Voice" below.

## Colour

Two grounds. **Sand** is the primary; **Bistre** is the dark theme. There is no third.

**Sand and Bistre are internal names.** They name the token sets and belong in this document,
in design studies and in code. What a reader sees is **light** and **dark**, lowercase, because
surrounding UI labels are lowercase and a capitalised control sits oddly among them.

**A theme control names and shows the theme it would switch _to_**, never the one already
active, and it is styled as the inverse of the current ground — so on Sand the control is dark
and reads `dark`. Appearance and label then agree, and the control explains itself without a
tooltip or an icon that has to be learned.

### Light — Sand

| Token | Value | vs ground | Role |
|---|---|---|---|
| `ground` | `#E7DCC6` | — | page |
| `surface` | `#EFE7D5` | — | cards, panels |
| `border` | `#CFC1A6` | — | card hairlines — decorative |
| `borderStrong` | `#8B7A61` | 3.06 | a control's *sole* boundary |
| `ink` | `#2A2419` | 11.32 | body text |
| `inkMute` | `#696051` | 4.55 | timestamps, captions, hashes |
| `green` | `#5E8C3A` | 2.92 | **the mark only** — logotype |
| `greenText` | `#476A2C` | 4.59 | links, chips, buttons, standing |
| `onGreen` | `#FAF6EC` | 5.78¹ | text on a green fill |
| `gold` | `#7F5A1C` | 4.57 | credits |
| `goldFill` | `#9B762D` | 3.08 | gold as a fill, never as text |
| `clay` | `#9A4A2F` | 4.55 | warning and error |

### Dark — Bistre

Measured against **`surface`**, not against `ground` — see "Which background a token is solved
against" below. `ground` figures are given alongside because they are strictly better here.

| Token | Value | vs surface | vs ground | Role |
|---|---|---|---|---|
| `ground` | `#211E18` | — | — | page |
| `surface` | `#2A261D` | — | — | cards, panels |
| `border` | `#3D3830` | — | — | card hairlines — decorative |
| `borderStrong` | `#7A6E5C` | 3.02 | 3.33 | a control's *sole* boundary |
| `ink` | `#E9E1CF` | 11.58 | 12.77 | body text |
| `inkMute` | `#978B77` | 4.50 | 4.97 | timestamps, captions, hashes |
| `green` | `#5E8C3A` | 3.80 | 4.19 | **the mark only** — logotype |
| `greenText` | `#679A40` | 4.50 | 4.96 | links, chips, buttons, standing |
| `onGreen` | `#141A0C` | 5.30¹ | 5.30¹ | text on a green fill |
| `gold` | `#B78328` | 4.51 | 4.98 | credits |
| `goldFill` | `#E8B84B` | 8.17 | 9.01 | gold as a fill, never as text |
| `clay` | `#CC7658` | 4.52 | 4.99 | warning and error |

¹ measured against the green fill, not against either ground.

Every value was solved numerically for the lightness landing closest to its target while
holding the hue — not chosen by eye and checked afterwards.

**Solve against the *quantised* value, not the continuous one.** A lightness that hits exactly
4.50 before rounding can land at 4.49 once it is written as an 8-bit hex triple. The first pass
at these five values did precisely that and three of them came out a hundredth under. Step the
lightness, round to hex, and measure *that* — the boundary is only real after quantisation.

### Which background a token is solved against

**Solve every token against whichever of `ground` / `surface` gives the *worse* ratio.** That is
`ground` on Sand and `surface` on Bistre, and the asymmetry is not a quirk — it falls out of
which way each theme's `surface` moves:

- On **Sand**, `surface` is *lighter* than `ground` and the text is dark, so text on a card has
  **more** contrast than text on the page. `ground` is the worst case.
- On **Bistre**, `surface` is also lighter than `ground` but the text is *light*, so text on a
  card has **less** contrast. `surface` is the worst case.

> ⚠ **This was got wrong, shipped, and is why five Bistre values changed on 2026-08-10.** Both
> themes were originally solved against `ground` alone. On Sand that was correct and the tokens
> measure 5.03 on a card. On Bistre it put `inkMute`, `greenText`, `gold` and `clay` at ~4.15
> against the 4.5 floor and `borderStrong` at 2.77 against its 3.0 floor — on cards and panels,
> which is where those tokens are mostly used. `docs.notis.fun` served that in dark mode from
> the day the theme landed.
>
> It was not caught by inspection because the two themes fail in opposite directions, so a
> spot-check of Sand confirms the method and says nothing about Bistre. It was found by
> computing the full matrix while solving an unrelated colour question, which is the second time
> a rendered or computed check has caught what reading the CSS did not.

### One green, three stops

Fern `#5E8C3A` (h 94°, s 41%, l 39%) is the brand green and **the mark's colour**. It measures
2.92:1 on Sand, which is legitimate for a logotype — WCAG exempts them — and unusable for
text. So the same hue carries two reading stops: `#476A2C` deep for light, `#679A40` lift for
dark. This is one green at three lightnesses, not three greens; do not introduce a fourth.

The mark's keyline is **Bottle `#1B2A12`**.

### Gold and clay are not interchangeable

**Gold means credits and nothing else.** Green/karma against gold/credits is the two-ledger
mapping already published on docs.notis.fun. Warnings must never be gold: in a system where
gold means money, a gold warning reads as being about the reader's balance. That is a
comprehension failure, not a matter of taste.

**Clay covers warning and error both**, separated by weight rather than by a second colour — a
soft tint for "heads up", the full rule for destructive. Four semantic hues starts to look
like a status dashboard, and a platform that is not chasing engagement genuinely does not have
that many states worth raising its voice about.

There is no red anywhere.

### Identity colour

The one categorical palette this contract defines: a per-identity hue derived from a public key and
rendered as a 4px spine.

**The arc is 175–345° in OKLCH** — cyan through blue and violet to magenta. That is what is left
after excluding every hue that already carries meaning: clay ~40° (warning), gold ~75° (credits),
green ~135° (karma), and red, which this contract bans outright.

**Widening the arc is not a free win**, and it is the rule here most likely to be found inconvenient.
A wider arc makes identities collide with meaning — one that hashes gold-ish reads as being about the
reader's balance, which is the same comprehension failure that forbids gold warnings.

**OKLCH, not HSL.** HSL degrees are perceptually uneven: 15° in the blues is nearly invisible while
15° in the yellows is a different colour, so even spacing in HSL is uneven spacing to the eye.

**Quantised to twelve evenly spaced stops, never sampled continuously.** Uniform sampling of a
continuous range *clumps*; it does not spread. Measured on a first cut, eight identities all landed
inside 196–253° — using 57° of the 120° then available — with one pair identical and another 1°
apart. Quantising turns every near-miss into either a clear difference or an exact repeat, **and an
exact repeat is better than a near-miss**: it reads as "same author" instead of sending the reader
back to compare.

⛔ **Identity colour is a texture, never an identifier.** Twelve stops collide at 43% with four
identities on screen and 78% with six, so colour cannot be what keeps them apart — the name and the
text are the discriminator. And nothing in an interface may invite a reader to check who someone is
by colour: if it did, impersonation would be cheap, because keys can be ground until one lands on a
target's stop.

### Chroma is area-weighted

A refinement of principle 1, and a general one. What raises arousal is coloured **area**, not
saturation alone. A whole-bar wash at low chroma reads as nothing; a 4px edge at high chroma reads
instantly and leaves the surface calm — roughly 100px² of colour against some 10,000px² for the wash.

A small, high-chroma mark therefore spends almost none of the arousal budget. That is what licenses
both the identity spine above and Fern at 2.92:1 for the logotype.

### A spine and a wash cannot share a lightness

A spine must contrast with the ground to be visible at 4px. A wash must sit *at* the ground's
lightness so text over it keeps its ratio. One value cannot do both: built from a single lightness, a
dark wash put `inkMute` at **2.94:1** on a focused bar.

**The wash steps away from the text, never toward it** — lighter than the base on Sand, darker on
Bistre. Solved that way against the measured grounds (OKLCH L .897/.929 on Sand, .236/.270 on Bistre)
the tint costs zero contrast in every combination of theme, mode and hue.

⚠ **A contrast-safe wash is nearly invisible on Sand**, whose ground already sits at L .929 with
almost no room for colour above it; it reads properly on Bistre. **Spine is the only mode that works
in both**, which is why it is the default and a wash is opt-in.

## Typography

| Role | Face | Licence |
|---|---|---|
| Everything a human writes or reads | **Plus Jakarta Sans** | SIL OFL 1.1, variable 400–700 |
| Machine-generated data only | **JetBrains Mono** | SIL OFL 1.1, variable 400–700 |

**Self-hosted, always.** A platform whose pitch is that it does not sell its users out cannot
load its fonts from Google on every page view. Both faces are OFL and ship with the surface.
This also constrains future choices to faces that can be legally redistributed.

**Mono is for machine data — hashes, keys, block heights, amounts — and nothing else.** Holding
that line is what makes it meaningful rather than decorative, and it has a second payoff: the
proportional face never has to render a string anyone might read aloud or re-type, so
ambiguous `1 l I` / `0 O` figures are not a selection criterion for it.

**Rows mixing mono with proportional type align on the baseline, never centred.** Flex centring
positions each item by its box, so the result depends on each family's ascent and descent
metrics — it looks fine until someone swaps a face, then silently breaks. This is structural,
not a per-font tweak.

## The mark

Ring of six figures, an N whose right stem is a flagpole, and a banner flying from it that
carries the mark again. It is a standard, not a seal.

### Construction

Parametric, in a 1000-unit box. `r_ring 372`, `stroke 64`, head `r 42` at radius `410`, slit
`3.2°`, keyline `4` units per side.

The keyline is applied by drawing each element once in ink, slightly larger, then again in
green on top. For the arcs, "larger" must mean a wider **angle** as well as a wider stroke —
the ink arcs span `58.03°` against the green arcs' `56.80°` — or the butt-cut end of each arm
is left unoutlined.

The banner's nested copy is sized by the **largest inscribed circle of the banner field**, not
its bounding box: the field is a wavy quadrilateral whose edges dip inward, and a circle placed
on the bbox overflows the top. It sits at 78% of that radius, 13.9× smaller per level.

The banner hangs so that its **top-right corner is level with the N's highest point**. That is
a stated rule rather than a measurement — the source drawings disagree about this position by
some 27 units — and it must be solved against the *rendered* outline, not the path vertices,
because the keyline's miter overshoots each corner by an amount that depends on how acute it
is.

### Tiers

The mark degrades by **resolution, not by presence**. The silhouette is a circle with an N in
it at every size; what varies is how finely the community is resolved. From a distance it is
one body, closer up it becomes individuals.

| Tier | Size | Contents |
|---|---|---|
| full | ≥ 160px | recursion, hollow banner, keyline, six figures |
| mid | 96–160 | hollow banner, keyline, six figures |
| small | 32–96 | six figures; no banner, no keyline |
| micro | ≤ 32 | continuous ring with heads, N only |

Both cut points were rendered and measured rather than reasoned about, and the first one was
wrong to begin with.

**The recursion survives to 160px.** The nested mark is 6.58% of the whole, so at 160px it is
about 11px across — abstract, but still reading as a mark inside the banner. At 128 it is a dot
with no structure, and at 96 a smudge. An earlier draft of this document put the boundary at
256, extrapolating from the small-size tests instead of rendering the range.

**The banner leaves at 96.** A solid banner is already a lump on the N's counter by 64px and
reads as damage to the letterform by 32. Dropping it beats simplifying it — that comparison was
made, not assumed.

Colours are driven by the CSS custom properties `--notis-green` and `--notis-keyline`, so the
artwork is inlined as SVG rather than referenced as an `<img>`; custom properties do not cross
into an image element.

## Motion

Every rule here is a prohibition, and together they are most of what keeps the place calm.

- **Motion only ever responds to a user action.** Nothing moves on its own — no autoplay, no
  ambient animation, no live-ticking counts, no "12 new posts" banner sliding in. If the feed
  changed, say so and wait.
- **No variable-ratio rewards.** Pull-to-refresh is a slot machine lever. Refresh is a button,
  and it reports what it did.
- **Numbers never animate.** No count-ups on karma or credits. A ticking number is a slot
  readout and it is the fastest way to make standing feel like a score.
- **Nothing already on screen may move.** No content reflowing under a cursor mid-read. The working
  form of this rule, with its boundary, is the next one.
- **Downward, below the point of action, in direct response to the reader's own click.** That is the
  working form of the rule above, and none of its three parts is optional. A composer opening under a
  post moves every card below it, and that is allowed: everything above the click holds still,
  everything below shifts down, and the reader's eye is at the post they acted on. Drop *downward*
  and content moves up under a cursor; drop *below the point of action* and things move above the
  reader's eye; drop *in direct response to the reader's own click* and it licenses exactly the
  injected "12 new posts" banner this section exists to forbid. New replies appending at the bottom of
  a thread on a pressed refresh are the same rule.
- **Pending state is the one legitimate unsolicited update, and it pays for itself in geometry.** A
  post the reader submitted may turn from hollow to landed without the reader asking, because the
  reader asked for the post. The price is identical geometry before and after — colour only, the meta
  row and the stage line one fixed line box, so what either contains cannot change the card's height —
  and a bounded watch: it runs only while the reader's own submissions are pending and stops at zero,
  it reconciles those entries and refreshes nothing else, and it moves no count. Anything else arriving
  unasked is the banner.
- **150ms ceiling, ease-out. `prefers-reduced-motion` means none** — not less, none.
- **Honest loading.** No fake progress, no skeleton shimmer. Shimmer is decorative motion
  impersonating progress.
- **Restoring a stored preference is not motion.** A theme recovered from storage or a URL must
  be *painted*, not transitioned into. Otherwise every transitioned property animates from the
  default palette to the chosen one on load — a visible flash of the wrong state, and movement
  nobody asked for. Suppress transitions until after the first paint. This one was found by
  measuring a screenshot that had caught the animation 11% of the way through, which is also a
  reminder that a rendered check catches what reasoning about the CSS does not.

## Interaction

The unifying idea: **you should be able to put your hands down without the interface
reacting.** Calm is not only how it looks — it is that it holds still when you are not asking
it for anything.

- **Every page reserves inert space.** The gutters beside the content column carry no handlers
  and no hover states, so there is always somewhere safe to click to focus the window or drop
  focus. This is why the column has a max-width instead of going full-bleed: the empty space
  is not waste, it is a control surface.
- **The control is the click target, never the container.** Cards and rows are not buttons.
  Text stays selectable and the pointer can be parked on it. This also removes the
  accidental-click pattern that quietly inflates engagement figures.
- **Hover may change appearance; it may never reveal content or move layout.** No hover menus,
  no hover previews, no tooltips that open on hover alone.
- **Hover is suppressed while scrolling and for ~100ms after it stops** (`pointer-events: none`
  on the container during scroll). A wheel-scrolling reader leaves the pointer parked, and
  without this whatever lands beneath it fires.

The last two also mean hover can never be load-bearing, which earns touch and keyboard access
as a consequence rather than a retrofit.

## Spacing

4px base. Scale: **4 8 12 16 24 32 48 64 96** — enough steps to be useful, few enough that
nobody reaches for an arbitrary number.

Measure capped near **62ch** for prose and a **≈660px** feed column: posts are capped at 300
bytes, so they are cards, not essays. Minimum **48px inert gutter** each side on desktop, which
is what makes the inert-space rule real rather than aspirational.

Inert gutters are impossible on a phone — but the problems they solve, focusing a window and
parking a pointer, do not exist on touch. The rule relaxes below the breakpoint, and that is a
reasoned exemption rather than a compromise. Recorded here so nobody later "fixes" the missing
gutters.

## Illustration

Draw **the society's own objects**: seals, stamps, ribbons, ledgers, keys, envelopes, benches,
and the people from the ring.

**Never botanical.** The obvious read of the register is sprigs and seeds, but the green was
steered away from eco specifically to dodge greenwash and party-green readings, and filling
the interface with plants walks straight back into it.

Technique is tied to the letterform: flat, faceted, straight-edged shapes with a little wobble
in the angles, no smooth curves. The N is 25 facets with slightly irregular angles; illustration
built the same way is unmistakably by the same hand, and it is a rule a contributor can
actually follow.

One per screen, per principle 5.

## Voice

Not preachy. The visual register avoids the manifesto; the copy has to as well.

- **Say what happens, not what went wrong.** "That invite has already been redeemed. Ask
  whoever sent it for another" — not "Error: invalid invite".
- **Never at the reader's expense.** No snark in error states, no cute apology that
  condescends.
- **Karma is described, never scored.** "vouched · steady", "long-standing". If a number must
  appear, it is not the headline.

## Accessibility contract

- Text meets **4.5:1** against **whichever of `ground` / `surface` it can actually land on** —
  not against `ground` alone. In practice that means `ground` on Sand and `surface` on Bistre;
  see "Which background a token is solved against". A token that clears the floor on the page
  and misses it on a card has not met this rule, and cards are where most muted text lives.
- A border meets **3:1**, under the same worst-case reading, only when it is a control's *sole*
  boundary. A ghost button has nothing but its outline and qualifies; a card hairline does not,
  because the card is identified by its surface tint and the line is decoration.
- The mark is exempt as a logotype, which is what licenses Fern at 2.92:1 on Sand.
- `prefers-reduced-motion` removes motion entirely.
- Hover is never the only route to anything.

## Deliberately not decided

- **A grid or layout system.** Owned by each surface.
- **Iconography.** Whether the illustration technique scales down to UI icons at 16–24px is
  untested and may need a separate, plainer treatment.
- **Data visualisation.** Nothing here covers charts. The only categorical palette this contract
  defines is the identity arc, and it is bounded by the hues that already carry meaning — see
  "Identity colour" — so it does not stretch to a chart's series either.

## Where the artwork lives

**Output is tracked; the pipeline that makes it is not.** A surface commits the artwork it
serves — the inlined mark sprite, `favicon.svg`, the font files — and the build script, the
traced letterform and the parametric source stay outside version control with whoever holds
them. This was a decision (2026-08-10), taken after the docs site landed; it was listed as
undecided in earlier drafts of this contract.

The consequence is worth stating plainly, because it is the sort of thing a contributor
discovers the hard way: **generated artwork cannot be regenerated from a clone.** Every
generated file says so in its own header. Hand-editing one is not a fix — it works until the
next regeneration elsewhere overwrites it, with nothing to flag that a change was lost. A
change to the mark has to go back through whoever holds the pipeline.

Each generated file also carries the parameters it was built from, so the drawing stays
reproducible on paper even where the script is absent.

**`favicon.svg` is the one piece with its colours baked in as literals.** Everything else
drives the mark through `--notis-green` and `--notis-keyline`, but a favicon is fetched
standalone and has no page to inherit custom properties from; left unbaked it renders in the
fallback bright green instead of Fern. The same applies to any future artwork loaded as a file
rather than inlined — social avatars, share cards, anything an `<img>` or a platform fetches
on its own.
