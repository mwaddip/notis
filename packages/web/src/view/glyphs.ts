// The interface's three icons — a person for the profile control, the moon on
// Sand / the sun on Bistre for the theme control, and the copy glyph for the
// link control on a card. Drawn in the house technique: flat, faceted,
// straight-edged, a little wobble in the angles, no smooth curves — every shape
// a polygon, never a circle or an arc (HOUSE_STYLE → Illustration,
// HOUSE_STYLE → Deliberately not decided, HOUSE_STYLE → Colour → "On a phone
// the theme control is a sun or a moon", WEB_INTERFACE → The profile window,
// WEB_INTERFACE → Links).

const NS = 'http://www.w3.org/2000/svg';

/** A 20×20 currentColor svg — the box every glyph is drawn in. fill inherits, so
 *  the polygons below need none of their own. */
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

/** Two offset sheets as polygons — the back sheet up-left, the front sheet
 *  down-right covering its corner. The standard copy icon, drawn in the house
 *  technique (HOUSE_STYLE → Illustration, WEB_INTERFACE → Links). */
export function copyGlyph(): SVGSVGElement {
  const svg = glyph();
  svg.appendChild(polygon('3,2.2 12.6,2 12.8,4.2 6.8,4.4 6.6,13.6 3.2,13.8'));   // back sheet
  svg.appendChild(polygon('7.2,6.2 17,6 17.2,17.6 7,17.8'));                       // front sheet
  return svg;
}
