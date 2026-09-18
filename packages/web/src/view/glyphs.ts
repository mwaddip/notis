// The interface's icons — a person for the profile control, a wallet for the
// wallet control, a gear for the settings control, the moon on Sand / the sun
// on Bistre for the standalone theme control, and the copy glyph for the link
// control on a card. Drawn in the house technique: flat, faceted, straight-
// edged, a little wobble in the angles, no smooth curves — every shape a
// polygon or an M/L/Z path, never a circle or an arc
// (HOUSE_STYLE → Illustration, HOUSE_STYLE → Deliberately not decided,
// HOUSE_STYLE → Colour → "On a phone the theme control is a sun or a moon",
// WEB_INTERFACE → The profile window, WEB_INTERFACE → Links).

const NS = 'http://www.w3.org/2000/svg';

/** A 20×20 currentColor svg — the box every glyph is drawn in. fill inherits, so
 *  the shapes below need none of their own. */
function glyph(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function polygon(points: string): SVGPolygonElement {
  const p = document.createElementNS(NS, 'polygon');
  p.setAttribute('points', points);
  return p;
}

/** A path in the house technique: `M`/`L`/`Z` only, `fill-rule="evenodd"` so a
 *  subpath drawn inside a body carves the hole. No curve command
 *  (HOUSE_STYLE → Illustration). */
function path(d: string): SVGPathElement {
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill-rule', 'evenodd');
  return p;
}

/** A head and shoulders — an irregular octagon over a trapezoid. */
export function personGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(polygon('10,2 12.2,2.9 13.2,5 12.3,7.1 10,8.2 7.7,7.2 6.8,5 7.8,2.8')); // head
  svg.appendChild(polygon('7.2,11 12.9,11.1 15.4,18 4.6,18'));                              // shoulders
  return svg;
}

/** An irregular octagon disc with eight short triangular rays. */
export function sunGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(polygon('10,6.8 12.2,7.7 13.2,10 12.3,12.3 10,13.2 7.7,12.4 6.8,10 7.8,7.7')); // disc
  for (const ray of [
    '10,2.1 11.2,5.7 8.8,5.6', '15,5 13.9,7.8 12.1,6.1', '17.1,10 14.3,11.2 14.4,8.8',
    '14.9,15 12.1,13.9 13.8,12.2', '10,17.2 8.8,14.3 11.2,14.4', '5,14.9 6.2,12.1 7.9,13.8',
    '2.9,10 5.7,8.8 5.6,11.2', '5.1,5 7.9,6.2 6.1,7.8',
  ]) svg.appendChild(polygon(ray));
  return svg;
}

/** A crescent as one polygon of straight segments — the outer edge bulging left,
 *  the inner edge concave, the horns to the right. No arc, no curve command. */
export function moonGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(polygon('13,2.8 8,3.4 4.6,6 3.1,10 4.6,14.1 8,16.6 13,17.2 10.2,15.2 8.1,12.2 7.6,10 8.1,7.8 10.2,4.8'));
  return svg;
}

/** A gear as one body: a single outline carrying eight teeth around a faceted
 *  hole. One `<path>` of `M`/`L`/`Z` only, `fill-rule="evenodd"` so the inner
 *  subpath carves the hole (HOUSE_STYLE → Illustration). */
export function gearGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(path(
    'M8.7 4.2 L8.9 1.6 L11.1 1.5 L11.3 4.2 L13.3 5.1 L15.3 3.4 L16.8 5.0 L15.0 6.9 L15.7 8.6 L18.4 8.8 L18.5 11.0 L15.8 11.2 L14.9 13.2 L16.7 15.2 L15.1 16.7 L13.1 15.0 L11.4 15.7 L11.3 18.4 L9.1 18.5 L8.8 15.8 L6.8 14.9 L4.7 16.7 L3.2 15.1 L5.0 13.1 L4.3 11.3 L1.6 11.2 L1.4 9.0 L4.2 8.8 L5.0 6.8 L3.3 4.8 L4.9 3.3 L6.9 5.0 Z ' +
    'M11.1 7.4 L12.4 9.1 L12.6 11.0 L11.0 12.5 L9.0 12.7 L7.6 10.9 L7.4 9.0 L9.0 7.6 Z',
  ));
  return svg;
}

/** A wallet as one body — the pouch with its clasp tab and coin-slot hole
 *  drawn as one `<path>` with `fill-rule="evenodd"`, the flap above it a
 *  polygon. The body is one path so the hole carves it (HOUSE_STYLE →
 *  Illustration, WEB_INTERFACE → The profile window → "Three header controls open the three windows — profile, wallet, settings — at the right of the app bar, the theme toggle after them at tiling"). */
export function walletGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(path(
    'M2.2 5.6 L15.6 5.2 L16.4 6.4 L16.5 8.4 L18.0 8.6 L18.1 12.6 L16.5 12.8 L16.4 15.6 L15.4 16.6 L3.2 16.5 L2.1 15.4 Z ' +
    'M13.2 9.6 L15.6 9.5 L15.7 11.8 L13.3 11.9 Z',
  ));
  svg.appendChild(polygon('3.0,3.9 13.9,2.6 15.0,4.2 3.2,4.6')); // the flap
  return svg;
}

/** Two offset sheets as polygons — the back sheet up-left, the front sheet
 *  down-right covering its corner. The standard copy icon, drawn in the house
 *  technique (HOUSE_STYLE → Illustration, WEB_INTERFACE → Links). */
export function copyGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(polygon('3,2.2 12.6,2 12.8,4.2 6.8,4.4 6.6,13.6 3.2,13.8'));   // back sheet
  svg.appendChild(polygon('7.2,6.2 17,6 17.2,17.6 7,17.8'));                       // front sheet
  return svg;
}
