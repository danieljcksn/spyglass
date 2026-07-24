// Presentation primitives. No sampling, no parsing, no network: these take
// numbers that lib.js already shaped and put them on screen. The Cairo maths
// lives in draw.js so it can be rendered to a PNG and inspected.
//
// House rules, applied without exception:
//   · figures carry two weights, the number solid and its unit dimmed, so a
//     row reads as one value rather than as a sentence
//   · colour means something or is absent; nothing is tinted for decoration
//   · lanes expand to the real content width, so edges align down the whole menu
//   · nothing scales, slides or eases on interaction

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {drawSparkline} from './draw.js';

// The menu's width is not a constant. It is set by the widest thing in it,
// usually the header subtitle carrying a distro string and a CPU model, and so
// differs from machine to machine. Lanes therefore EXPAND to whatever that
// turns out to be rather than being pinned to a guess: a meter that stops short
// of the hairline above it is the single most visible way to look unfinished.
const SPARK_HEIGHT = 20;
const HISTORY = 60;

/* ── figure ──────────────────────────────────────────────────────────────── */

// A number and its unit, set in two weights. Percent signs hug their number;
// word units get a space. Getting this wrong is the difference between "8%"
// and "8 %", which is small and awful.
export const Figure = GObject.registerClass(
class Figure extends St.BoxLayout {
    _init() {
        super._init({style_class: 'sg-figure', y_align: Clutter.ActorAlign.CENTER});
        this._value = new St.Label({
            style_class: 'sg-figure-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._unit = new St.Label({
            style_class: 'sg-figure-unit',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
        this.add_child(this._unit);
    }

    set(value, unit = '', severityClass = '') {
        this._value.text = `${value}`;
        const tight = unit === '%';
        this._unit.text = unit;
        this._unit.visible = !!unit;
        if (tight)
            this._unit.add_style_class_name('sg-figure-unit-tight');
        else
            this._unit.remove_style_class_name('sg-figure-unit-tight');
        for (const c of ['sg-warn', 'sg-crit'])
            this._value.remove_style_class_name(c);
        if (severityClass)
            this._value.add_style_class_name(severityClass);
    }
});

/* ── bar ─────────────────────────────────────────────────────────────────── */

// A hairline meter.
//
// This is a BoxLayout rather than a Bin on purpose: St.Bin CENTRES its child,
// which silently rendered every fill as a floating segment in the middle of its
// track instead of growing from the left edge. A BoxLayout packs from the
// start, so the geometry is not a matter of alignment properties at all.
export const Bar = GObject.registerClass(
class Bar extends St.BoxLayout {
    _init() {
        super._init({style_class: 'sg-bar-track', x_expand: true});
        this._percent = 0;
        this._fill = new St.Widget({
            style_class: 'sg-bar-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._fill);
        // The track's own width is not known until it has been allocated, and
        // it changes with the menu. Recompute the fill whenever it moves.
        this.connect('notify::width', () => this._apply());
    }

    set(percent, severityClass = '') {
        this._percent = Math.max(0, Math.min(100, percent ?? 0));
        for (const c of ['sg-warn', 'sg-crit'])
            this._fill.remove_style_class_name(c);
        if (severityClass)
            this._fill.add_style_class_name(severityClass);
        this._apply();
    }

    _apply() {
        const width = this.get_width();
        if (!width)
            return;
        // A non-zero value must never round away to nothing, and a full one
        // must not overshoot the track by a subpixel.
        let px = Math.round((width * this._percent) / 100);
        if (this._percent > 0)
            px = Math.max(2, px);
        // set_width, not a style: this runs on every allocation, and reparsing
        // CSS to move a meter three pixels would be absurd.
        this._fill.set_width(px);
        this._fill.visible = px > 0;
    }
});

/* ── sparkline ───────────────────────────────────────────────────────────── */

// Recent history. This is what turns an instant percentage into something you
// can read a trend off: 90% and falling is a different situation from 90% and
// climbing, and no single number can tell you which you are looking at.
export const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init(capacity = HISTORY, height = SPARK_HEIGHT) {
        super._init({style_class: 'sg-spark', x_expand: true});
        this._values = [];
        this._capacity = capacity;
        // Height only. The width comes from the allocation, exactly as the
        // meter below it does, so the two always share both edges.
        this.set_style(`height: ${height}px;`);
    }

    push(value) {
        if (value === null || value === undefined || Number.isNaN(value))
            return;
        this._values.push(value);
        if (this._values.length > this._capacity)
            this._values.shift();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();

        let rgb = {r: 1, g: 1, b: 1};
        try {
            const c = this.get_theme_node().get_foreground_color();
            rgb = {r: c.red / 255, g: c.green / 255, b: c.blue / 255};
        } catch (_e) {
            // Keep the default tint rather than dropping the whole repaint.
        }

        drawSparkline(cr, w, h, this._values, this._capacity, rgb);
        cr.$dispose();
    }
});

/* ── stat block ──────────────────────────────────────────────────────────── */

// One metric, fully expressed: name, headline figure, optional history, meter,
// and a line of absolute detail. The absolutes are the point. A percentage
// alone tells you the shape of a problem but never its size.
export const StatBlock = GObject.registerClass(
class StatBlock extends St.BoxLayout {
    _init(name, {sparkline = false} = {}) {
        super._init({style_class: 'sg-block', vertical: true});

        const head = new St.BoxLayout({style_class: 'sg-block-head'});
        this._name = new St.Label({
            text: name,
            style_class: 'sg-block-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._figure = new Figure();
        head.add_child(this._name);
        head.add_child(this._figure);
        this.add_child(head);

        this._spark = sparkline ? new Sparkline() : null;
        if (this._spark)
            this.add_child(this._spark);

        this._bar = new Bar();
        this.add_child(this._bar);

        this._detail = new St.Label({style_class: 'sg-block-detail'});
        this.add_child(this._detail);

        this._sub = new St.Label({style_class: 'sg-block-sub'});
        this.add_child(this._sub);
    }

    setName(name) {
        this._name.text = name;
    }

    pushHistory(value) {
        this._spark?.push(value);
    }

    redrawHistory() {
        this._spark?.queue_repaint();
    }

    update({value, unit, percent, severityClass, detail, sub}) {
        this._figure.set(value, unit, severityClass);
        this._bar.set(percent, severityClass);
        this._detail.text = detail ?? '';
        this._detail.visible = !!detail;
        this._sub.text = sub ?? '';
        this._sub.visible = !!sub;
    }
});

/* ── key/value row ───────────────────────────────────────────────────────── */

export const KeyValue = GObject.registerClass(
class KeyValue extends St.BoxLayout {
    _init(name) {
        super._init({style_class: 'sg-kv'});
        this._key = new St.Label({
            text: name,
            style_class: 'sg-kv-key',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = new St.Label({
            text: '--',
            style_class: 'sg-kv-val',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._key);
        this.add_child(this._value);
    }

    setKey(text) {
        this._key.text = text;
    }

    set(text, severityClass = '') {
        this._value.text = text;
        for (const c of ['sg-warn', 'sg-crit'])
            this._value.remove_style_class_name(c);
        if (severityClass)
            this._value.add_style_class_name(severityClass);
    }
});

/* ── hairline ────────────────────────────────────────────────────────────── */

export function hairline() {
    return new St.Widget({style_class: 'sg-hairline'});
}
