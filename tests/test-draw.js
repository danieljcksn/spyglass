#!/usr/bin/env -S gjs -m
//
//   gjs -m test-draw.js /output/dir
//
// Renders the sparkline against the real menu background colour at the real
// content width, so the result can be looked at instead of guessed about.

import cairo from 'gi://cairo';
import GLib from 'gi://GLib';

import {drawSparkline} from '../src/draw.js';

const OUT = ARGV[0] ?? '.';
const W = 268;
const H = 20;
const CAP = 60;

// gnome-shell's dark menu background, so alphas are judged in context.
const BG = {r: 0.145, g: 0.145, b: 0.153};
const FG = {r: 1, g: 1, b: 1};

function series(fn, n = CAP) {
    return Array.from({length: n}, (_, i) => fn(i));
}

const CASES = [
    ['idle-8pct', series(i => 8 + Math.sin(i / 3) * 2)],
    ['busy-60pct', series(i => 60 + Math.sin(i / 4) * 8)],
    ['pegged-100pct', series(() => 100)],
    ['zero', series(() => 0)],
    ['spiky', series(i => (i % 7 === 0 ? 95 : 12) + Math.sin(i) * 3)],
    ['ramp', series(i => (i / CAP) * 100)],
    ['half-full-history', series(i => 40 + Math.sin(i / 2) * 20, 22)],
    ['two-samples', [30, 70]],
    ['single-sample', [50]],
    ['empty', []],
];

// One tall strip: every case stacked, each labelled by position, so a single
// image shows how the treatment holds up across the whole range.
const rows = CASES.length;
const gap = 10;
const stripH = rows * (H + gap) + gap;
const surface = new cairo.ImageSurface(cairo.Format.ARGB32, W + 40, stripH);
const cr = new cairo.Context(surface);

cr.setSourceRGB(BG.r, BG.g, BG.b);
cr.paint();

CASES.forEach(([name, values], idx) => {
    const y = gap + idx * (H + gap);
    cr.save();
    cr.translate(20, y);
    drawSparkline(cr, W, H, values, CAP, FG);
    cr.restore();
    print(`row ${idx}: ${name}  (${values.length} samples)`);
});

cr.$dispose();
const path = GLib.build_filenamev([OUT, 'sparklines.png']);
surface.writeToPNG(path);
print(`\nwrote ${path}  ${W + 40}x${stripH}`);
