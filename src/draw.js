// Cairo drawing, isolated from St so it can be rendered to a PNG and inspected
// pixel by pixel outside gnome-shell. See test-draw.js.
//
// Keeping this separate is not ceremony. A sparkline is the one part of this
// interface whose correctness cannot be asserted from a number: it has to be
// looked at. Making it renderable offline is what turns "looks about right"
// into something checkable.

// Visual weight of the history graph. The fill exists to give the line a body
// so the eye reads a shape rather than a squiggle; it must never read as a
// filled block. At 100% utilisation the fill covers the entire lane, so this
// alpha is chosen for how it looks at its WORST case, not its average.
const FILL_ALPHA = 0.10;
const LINE_ALPHA = 0.85;
const LINE_WIDTH = 1.25;

// Breathing room at the top so a pegged 100% line is not clipped flush against
// the edge, and at the bottom so a 0% line sits on the baseline rather than
// under it.
const PAD_TOP = 2.5;
const PAD_BOTTOM = 1.5;

// The lane deliberately draws NO baseline of its own. The meter sits directly
// beneath it at the same width, and two grey horizontals four pixels apart read
// as noise rather than as structure. The bar is the anchor; the graph floats
// above it. The lane keeps its height from the fixed style, so an empty history
// still reserves its space and the menu never reflows as samples arrive.
export function drawSparkline(cr, width, height, values, capacity, rgb) {
    const {r, g, b} = rgb;

    if (!values || values.length < 2)
        return;

    const n = values.length;
    const usable = height - PAD_TOP - PAD_BOTTOM;
    // Spacing is derived from capacity, not from the number of samples held, so
    // the line grows leftward at a constant rate instead of stretching to fit.
    const step = width / (capacity - 1);
    const x0 = width - (n - 1) * step;
    const xOf = i => x0 + i * step;
    const yOf = v => PAD_TOP + usable - (Math.max(0, Math.min(100, v)) / 100) * usable;

    cr.moveTo(xOf(0), height);
    for (let i = 0; i < n; i++)
        cr.lineTo(xOf(i), yOf(values[i]));
    cr.lineTo(xOf(n - 1), height);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, FILL_ALPHA);
    cr.fill();

    cr.setLineWidth(LINE_WIDTH);
    cr.setSourceRGBA(r, g, b, LINE_ALPHA);
    cr.moveTo(xOf(0), yOf(values[0]));
    for (let i = 1; i < n; i++)
        cr.lineTo(xOf(i), yOf(values[i]));
    cr.stroke();
}
