# Spyglass

A GNOME Shell panel indicator that shows CPU, memory, disk, GPU and network for
**this** machine, and switches to a **remote** machine on a click.

Existing panel monitors (Vitals, Resource Monitor, Freon) all read the machine
they run on. This one is for the case where the machine you care about is not
the machine in front of you: a workstation under the desk, a build box, a VM on
the LAN. Click the indicator and the whole readout swaps over.

```
  ⌂ kruskal   8%  73°  60%  93%          ← local, read from /proc and /sys
  ▤ work     23%  0·0  49%  72%          ← remote, read over the Glances API
```

The two sources never look alike. The remote one carries a server glyph, its
hostname, an accent-tinted pill and a hairline border, because a number without
provenance is worse than no number.

## What it shows

Left click toggles the source. Right click opens the full readout: history,
meters, and the absolute figures behind every percentage.

The menu groups metrics by how they *behave*, not by what they are. Things that
move second to second (processor, memory, graphics) carry a sparkline. Things
that move over hours (disk, swap) carry only a meter, because a flat line drawn
for its own sake is decoration.

| | local | remote |
|---|---|---|
| processor | `/proc/stat` deltas, with user/sys/io/steal split | Glances `cpu` |
| memory | `/proc/meminfo`, incl. available and cached | Glances `mem`, `memswap` |
| disk | `statvfs`, shown as **used** | Glances `fs`, root mount |
| graphics | `nvidia-smi`: load, temperature, VRAM | not applicable |
| temperature | `coretemp` / `k10temp` / `zenpower` via hwmon | see below |
| network | `/proc/net/dev` on the default route | Glances `network` |
| load, uptime, processes | `/proc/loadavg`, `/proc/uptime` | Glances `load`, `uptime`, `processcount` |

### Machines with no thermal sensors

A VM guest has no path to the host's thermal hardware: `/sys/class/hwmon`
carries no `temp*_input` at all, and installing `lm-sensors` there will report
nothing, because there is nothing to report.

So on a source with no sensors the temperature slot shows **`iowait · steal`**
instead. Steal is the VM-native version of the signal temperature gives you on
real silicon — something outside this machine is hurting it — and iowait is
what actually saturates most virtualised boxes.

## Install

```sh
make install
```

Then restart GNOME Shell: **Alt+F2**, type **r**, Enter. (X11 only. On Wayland,
log out and back in.)

> Do not use `gnome-shell --replace` to reload. It starts a shell outside
> systemd's supervision which takes the `org.gnome.Shell` bus name; the real
> unit then fails with *"already exists on bus"*, exhausts its restart limit,
> and drops the session into the "Oh no! Something has gone wrong" screen.

Enable it, then set the remote address in **Settings** from the menu. Until an
address is set, the remote source reports itself as needing setup rather than
pretending to be offline.

## The remote agent

The remote machine runs [Glances](https://github.com/nicolargo/glances) in web
mode. No root needed:

```sh
python3 -m venv ~/.local/share/glances-venv
~/.local/share/glances-venv/bin/pip install "glances[web]"
```

Then install `agent/glances-web.service` to `~/.config/systemd/user/` and:

```sh
systemctl --user daemon-reload
systemctl --user enable --now glances-web.service
loginctl enable-linger "$USER"     # so it survives logout and starts at boot
```

Three things that will cost you an hour if you discover them yourself:

- **The flags are `-B` and `-p`, not `--bind` and `--port`.** argparse accepts
  the long spellings as abbreviations of unrelated options, then never starts
  the listener, and logs nothing about it.
- **Startup takes 15 to 60 seconds** while plugins load, longer on an I/O-bound
  box. The service reports `active` the whole time with nothing listening.
- **Disable the expensive plugins.** The shipped unit does. It is what lets the
  extension read the entire machine in *one* request per poll instead of six.
  That is not a micro-optimisation: at six parallel requests every three
  seconds, a single-worker uvicorn accumulated CLOSE-WAIT sockets until it
  wedged completely, refused connections from `127.0.0.1`, and ignored SIGTERM.

### Exposure

The agent binds `0.0.0.0` with no authentication and permissive CORS, and warns
about both at startup. On a LAN you control that is usually fine, but any page
your browser loads can read those metrics via DNS rebinding. Add `--password`
to `ExecStart` if that matters to you.

## Development

```
src/       the extension
  lib.js       sampling, parsing, shaping. Imports nothing from gnome-shell.
  draw.js      Cairo maths for the sparkline. Imports only cairo.
  widgets.js   St widgets: figures, meters, blocks, rows.
  extension.js wiring only.
tests/     run under plain gjs, no Shell required
agent/     systemd unit for the remote Glances agent
```

The layering exists so the parts that can be checked, are:

```sh
make test-lib     # real /proc, real nvidia-smi; add a host for the remote half
make test-draw    # renders build/sparklines.png so the graph can be LOOKED at
```

The live-HTTP half is opt-in and skips cleanly without an agent. `test-lib` covers invariants worth having, like `used + available == total` and
that interface selection skips `lo` and `docker0`. `test-draw` renders the
sparkline across its whole range — idle, pegged, spiky, partial history, two
samples, empty — because a graph is the one thing whose correctness cannot be
asserted from a number.

Point the live-HTTP half at a real agent:

```sh
make test-lib SPYGLASS_TEST_HOST=http://192.168.0.81:61208/api/4
```

## Design

Four type sizes. A 4px spacing grid whose rhythm doubles with each level of
separation: 4px inside a figure, 8px inside a block, 16px between blocks, 32px
between groups. One 268px content width, so every meter and graph shares a left
and a right edge down the whole menu. Colour only ever means source, warning or
critical. Nothing scales, slides or eases.

## Licence

GPL-2.0-or-later.
