// Spyglass
//
// One button in the top bar. Left click toggles which machine it reports on:
//
//   local   this machine, read straight from /proc, /sys and nvidia-smi
//   remote  a box running the Glances REST API, read over HTTP
//
// The two sources are styled differently on purpose: the remote one gets an
// accent-tinted pill, a server glyph and its hostname, because a number with no
// provenance is worse than no number. You must never have to wonder which box
// is at 90%.
//
// The menu groups metrics by how they behave rather than by what they are:
// things that move second to second (processor, memory, graphics) carry
// history; things that move over hours (disk, swap) carry only a meter. Giving
// a disk a sparkline would be drawing a flat line for its own sake.
//
// Layering is strict. lib.js samples and shapes, importing nothing from
// gnome-shell so it can be tested under plain gjs (test-lib.js). draw.js does
// the Cairo maths, renderable to a PNG offline (test-draw.js). widgets.js
// draws. This file only wires them together.

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    buildLocalData, fetchRemoteData, readLocalGpu,
    fmtBytes, fmtRate, fmtRateShort, fmtUptime, pct, severity,
} from './lib.js';
import {StatBlock, KeyValue, hairline} from './widgets.js';

const PANEL_FIELDS = ['cpu', 'aux', 'ram', 'disk', 'gpu', 'net'];

const SpyglassIndicator = GObject.registerClass(
class SpyglassIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Spyglass', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 5, idle_timeout: 15});
        this._inFlight = false;
        this._gpuInFlight = false;
        this._localSample = {};
        // Last good record per source, so toggling paints instantly instead of
        // flashing placeholders while the first poll of the new source lands.
        this._cache = {local: null, remote: null};

        this._buildPanel();
        this._buildMenu();

        this._settingsIds = [
            this._settings.connect('changed::source', () => this._onSourceChanged()),
            this._settings.connect('changed::poll-seconds', () => this._restartTimer()),
        ];
        for (const key of PANEL_FIELDS) {
            this._settingsIds.push(this._settings.connect(
                `changed::panel-show-${key}`, () => this._renderPanel(this._cache[this._sourceKey])));
        }

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._refresh();
            this._renderMenu(this._cache[this._sourceKey]);
        });

        this._applySourceStyle();
    }

    get _isRemote() {
        return this._settings.get_string('source') === 'remote';
    }

    get _sourceKey() {
        return this._isRemote ? 'remote' : 'local';
    }

    get _remoteBase() {
        const host = this._settings.get_string('remote-host');
        const port = this._settings.get_int('remote-port');
        return `http://${host}:${port}/api/4`;
    }

    /* ── panel ───────────────────────────────────────────────────────────── */

    _buildPanel() {
        this._pill = new St.BoxLayout({
            style_class: 'sg-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({style_class: 'sg-icon', y_align: Clutter.ActorAlign.CENTER});
        this._pill.add_child(this._icon);

        this._tag = new St.Label({style_class: 'sg-tag', y_align: Clutter.ActorAlign.CENTER});
        this._pill.add_child(this._tag);

        this._fields = {};
        for (const key of PANEL_FIELDS) {
            const label = new St.Label({
                style_class: 'sg-metric',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._fields[key] = label;
            this._pill.add_child(label);
        }

        this.add_child(this._pill);
    }

    _fieldEnabled(key) {
        if (key === 'cpu')
            return true;
        // A GPU reading is meaningless for a box that has no GPU, and the
        // remote one may well be a VM, so the slot collapses entirely.
        if (key === 'gpu' && (this._isRemote || !this._cache.local?.gpu))
            return false;
        return this._settings.get_boolean(`panel-show-${key}`);
    }

    /* ── menu ────────────────────────────────────────────────────────────── */

    _buildMenu() {
        // Scopes the padding override below. Without it the action items keep
        // gnome-shell's default indent and sit a few pixels left of every label
        // in the readout, which is exactly the kind of near-miss that makes a
        // menu feel assembled rather than designed.
        this.menu.box.add_style_class_name('sg-menu');

        const section = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        section.style_class = 'sg-menu-section';
        const body = new St.BoxLayout({vertical: true, style_class: 'sg-body'});
        section.add_child(body);
        this.menu.addMenuItem(section);

        const header = new St.BoxLayout({style_class: 'sg-header'});
        const titles = new St.BoxLayout({vertical: true, x_expand: true});
        this._hostLabel = new St.Label({text: '', style_class: 'sg-host'});
        this._subLabel = new St.Label({text: '', style_class: 'sg-hostsub'});
        titles.add_child(this._hostLabel);
        titles.add_child(this._subLabel);
        header.add_child(titles);
        // START, not CENTER: the title beside it is two lines, and a chip
        // centred against both floats in the gutter between them instead of
        // sitting on the hostname it qualifies.
        this._chip = new St.Label({
            text: '',
            style_class: 'sg-chip',
            y_align: Clutter.ActorAlign.START,
        });
        header.add_child(this._chip);
        body.add_child(header);

        this._rules = [hairline(), hairline(), hairline()];
        body.add_child(this._rules[0]);

        // Live group: sampled continuously, so history earns its space.
        this._blocks = {
            cpu: new StatBlock('Processor', {sparkline: true}),
            mem: new StatBlock('Memory', {sparkline: true}),
            gpu: new StatBlock('Graphics', {sparkline: true}),
            disk: new StatBlock('Disk'),
            swap: new StatBlock('Swap'),
        };
        for (const key of ['cpu', 'mem', 'gpu'])
            body.add_child(this._blocks[key]);

        body.add_child(this._rules[1]);

        // Capacity group: changes over hours, so a meter says everything a
        // graph would, in a fifth of the height.
        for (const key of ['disk', 'swap'])
            body.add_child(this._blocks[key]);

        body.add_child(this._rules[2]);

        this._rows = {
            aux: new KeyValue('Temperature'),
            net: new KeyValue('Network'),
            procs: new KeyValue('Processes'),
            uptime: new KeyValue('Uptime'),
        };
        for (const row of Object.values(this._rows))
            body.add_child(row);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._switchItem = new PopupMenu.PopupMenuItem('');
        this._switchItem.connect('activate', () => this._toggleSource());
        this.menu.addMenuItem(this._switchItem);

        this._dashItem = new PopupMenu.PopupMenuItem('Open dashboard');
        this._dashItem.connect('activate', () => {
            const host = this._settings.get_string('remote-host');
            const port = this._settings.get_int('remote-port');
            Gio.AppInfo.launch_default_for_uri(`http://${host}:${port}/`, null);
        });
        this.menu.addMenuItem(this._dashItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings');
        prefsItem.connect('activate', () => {
            // openPreferences hands back a promise that rejects if the prefs
            // window cannot be opened. Unhandled, that lands in the journal as
            // a bare stack trace with no hint of what the user clicked.
            try {
                const p = this._extension.openPreferences();
                if (p?.catch)
                    p.catch(e => logError(e, 'spyglass: openPreferences'));
            } catch (e) {
                logError(e, 'spyglass: openPreferences');
            }
        });
        this.menu.addMenuItem(prefsItem);
    }

    /* ── interaction ─────────────────────────────────────────────────────── */

    // Left click toggles, right click opens the menu. PanelMenu.Button would
    // normally open the menu on left click, which is why this is overridden
    // rather than just connecting to a signal.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                this._toggleSource();
                return Clutter.EVENT_STOP;
            }
            if (button === Clutter.BUTTON_SECONDARY) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
        } else if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._toggleSource();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _toggleSource() {
        this._settings.set_string('source', this._isRemote ? 'local' : 'remote');
    }

    _onSourceChanged() {
        this._applySourceStyle();
        const cached = this._cache[this._sourceKey];
        this._renderPanel(cached);
        if (this.menu.isOpen)
            this._renderMenu(cached);
        this._refresh();
    }

    _applySourceStyle() {
        const remote = this._isRemote;
        const localName = GLib.get_host_name().toLowerCase();
        const remoteName = this._settings.get_string('remote-label');
        this._pill.remove_style_class_name(remote ? 'sg-local' : 'sg-remote');
        this._pill.add_style_class_name(remote ? 'sg-remote' : 'sg-local');
        this._icon.icon_name = remote ? 'network-server-symbolic' : 'computer-symbolic';
        this._tag.text = remote ? remoteName : localName;
        this._chip.text = remote ? 'remote' : 'this machine';
        this._chip.remove_style_class_name(remote ? 'sg-chip-local' : 'sg-chip-remote');
        this._chip.add_style_class_name(remote ? 'sg-chip-remote' : 'sg-chip-local');
        this._switchItem.label.text = `Switch to ${remote ? localName : remoteName}`;
        this._dashItem.visible = remote;
    }

    /* ── sampling ────────────────────────────────────────────────────────── */

    _refresh() {
        if (this._isRemote)
            this._refreshRemote();
        else
            this._refreshLocal();
    }

    _paint(data) {
        this._renderPanel(data);
        if (this.menu.isOpen)
            this._renderMenu(data);
    }

    _refreshLocal() {
        const {data, sample} = buildLocalData(this._localSample);
        this._localSample = sample;
        // Carry the last known GPU reading so the row does not blink between
        // the synchronous sample and the asynchronous nvidia-smi result.
        data.gpu = this._cache.local?.gpu ?? null;
        this._cache.local = data;
        this._accumulate('local', data);
        if (!this._isRemote)
            this._paint(data);
        this._refreshGpu();
    }

    _refreshGpu() {
        if (this._gpuInFlight)
            return;
        this._gpuInFlight = true;
        readLocalGpu(this._cancellable)
            .then(gpu => {
                if (!this._cache.local)
                    return;
                this._cache.local.gpu = gpu;
                this._blocks.gpu.pushHistory(gpu?.percent);
                if (!this._isRemote)
                    this._paint(this._cache.local);
            })
            .catch(() => {})
            .finally(() => {
                this._gpuInFlight = false;
            });
    }

    async _refreshRemote() {
        // Nothing is configured yet on a fresh install. That is a setup state,
        // not a failure: calling a machine whose address nobody has entered
        // "offline" would be a lie, and would send people hunting for a network
        // problem that does not exist.
        if (!this._settings.get_string('remote-host')) {
            const data = {ok: false, unconfigured: true};
            this._cache.remote = data;
            this._paint(data);
            return;
        }
        // A slow or dead box must never queue up requests behind itself.
        if (this._inFlight)
            return;
        this._inFlight = true;
        try {
            const data = await fetchRemoteData(this._session, this._remoteBase, this._cancellable);
            this._cache.remote = data;
            this._accumulate('remote', data);
            if (this._isRemote)
                this._paint(data);
        } catch (_e) {
            // Unreachable is a normal state, not an error worth logging every
            // three seconds: the box gets suspended, the LAN drops, you leave.
            const data = {ok: false};
            this._cache.remote = data;
            if (this._isRemote)
                this._paint(data);
        } finally {
            this._inFlight = false;
        }
    }

    // History accumulates only for the source on screen. Sampling the other one
    // in the background to keep its graph warm would mean polling a machine
    // nobody is looking at, every three seconds, forever.
    _accumulate(key, data) {
        if (!data?.ok || key !== this._sourceKey)
            return;
        this._blocks.cpu.pushHistory(data.cpu?.percent);
        this._blocks.mem.pushHistory(data.mem?.percent);
    }

    /* ── painting ────────────────────────────────────────────────────────── */

    _setField(key, text, sev) {
        const label = this._fields[key];
        label.text = text;
        // Empty is not the same as blank: a label with no text still claims its
        // min-width, which left a run of dead space inside the pill whenever a
        // metric was unavailable.
        label.visible = this._fieldEnabled(key) && !!text;
        for (const c of ['sg-warn', 'sg-crit'])
            label.remove_style_class_name(c);
        if (sev)
            label.add_style_class_name(sev);
    }

    _renderPanel(data) {
        if (!data) {
            this._pill.remove_style_class_name('sg-offline');
            for (const key of PANEL_FIELDS)
                this._setField(key, key === 'cpu' ? '·  ·  ·' : '', '');
            return;
        }

        if (data.ok === false) {
            this._pill.add_style_class_name('sg-offline');
            const word = data.unconfigured ? 'set up' : 'offline';
            for (const key of PANEL_FIELDS)
                this._setField(key, key === 'cpu' ? word : '', '');
            return;
        }

        this._pill.remove_style_class_name('sg-offline');
        this._setField('cpu', pct(data.cpu?.percent), severity(data.cpu?.percent));
        this._setField('aux', data.aux ?? '', data.auxSeverity ?? '');
        this._setField('ram', pct(data.mem?.percent), severity(data.mem?.percent));
        this._setField('disk', pct(data.disk?.percent), severity(data.disk?.percent));
        this._setField('gpu', data.gpu ? pct(data.gpu.percent) : '', severity(data.gpu?.percent));
        this._setField(
            'net',
            data.net?.iface ? `↓${fmtRateShort(data.net.rxRate)} ↑${fmtRateShort(data.net.txRate)}` : '',
            '');
    }

    _renderMenu(data) {
        const blocks = this._blocks;
        const ok = !!data?.ok;

        for (const block of Object.values(blocks))
            block.visible = ok;
        for (const row of Object.values(this._rows))
            row.visible = ok;
        for (const rule of this._rules)
            rule.visible = ok;

        if (!ok) {
            this._hostLabel.text = this._isRemote
                ? this._settings.get_string('remote-label')
                : GLib.get_host_name().toLowerCase();
            this._subLabel.text = data?.unconfigured
                ? 'no address set, open Settings'
                : data?.ok === false
                    ? `no response from ${this._settings.get_string('remote-host')}`
                    : 'sampling';
            return;
        }

        this._hostLabel.text = data.host ?? '';
        this._subLabel.text = [
            data.os,
            data.cpuModel,
            data.cores ? `${data.cores} cores` : null,
        ].filter(Boolean).join('   ·   ');

        /* processor */
        const cpuBits = ['user', 'system', 'iowait']
            .map(k => [k === 'system' ? 'sys' : k === 'iowait' ? 'io' : k, data.cpu?.[k]])
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([name, v]) => `${name} ${Math.round(v)}%`);
        if (data.cpu?.steal)
            cpuBits.push(`steal ${Math.round(data.cpu.steal)}%`);
        blocks.cpu.update({
            value: data.cpu?.percent === null || data.cpu?.percent === undefined
                ? '--' : Math.round(data.cpu.percent),
            unit: '%',
            percent: data.cpu?.percent,
            severityClass: severity(data.cpu?.percent),
            // Dots separate different quantities, here and in every other
            // detail line. The load triple below is deliberately NOT dotted:
            // it is one quantity at three time windows, not three quantities,
            // and its spacing is uniform so the word does not crowd the first
            // figure while the rest sit far apart.
            detail: cpuBits.join('   ·   '),
            sub: data.load
                ? `load  ${data.load.min1.toFixed(2)}  ${data.load.min5.toFixed(2)}  ${data.load.min15.toFixed(2)}`
                : null,
        });
        blocks.cpu.redrawHistory();

        /* memory */
        blocks.mem.visible = !!data.mem;
        if (data.mem) {
            const used = fmtBytes(data.mem.usedBytes);
            const total = fmtBytes(data.mem.totalBytes);
            const avail = fmtBytes(data.mem.availBytes);
            const cached = data.mem.cachedBytes ? fmtBytes(data.mem.cachedBytes) : null;
            blocks.mem.update({
                value: used.value,
                unit: `${used.unit} of ${total.value} ${total.unit}`,
                percent: data.mem.percent,
                severityClass: severity(data.mem.percent),
                detail: [
                    `${Math.round(data.mem.percent)}%`,
                    `${avail.value} ${avail.unit} available`,
                    cached ? `${cached.value} ${cached.unit} cached` : null,
                ].filter(Boolean).join('   ·   '),
                sub: null,
            });
            blocks.mem.redrawHistory();
        }

        /* graphics */
        blocks.gpu.visible = !!data.gpu;
        if (data.gpu) {
            const used = fmtBytes(data.gpu.usedBytes);
            const total = fmtBytes(data.gpu.totalBytes);
            blocks.gpu.update({
                value: Math.round(data.gpu.percent),
                unit: '%',
                percent: data.gpu.percent,
                severityClass: severity(data.gpu.percent),
                detail: [
                    `${used.value} ${used.unit} of ${total.value} ${total.unit} vram`,
                    Number.isNaN(data.gpu.temp) ? null : `${Math.round(data.gpu.temp)} °C`,
                ].filter(Boolean).join('   ·   '),
                sub: data.gpu.name,
            });
            blocks.gpu.redrawHistory();
        }

        /* disk */
        blocks.disk.visible = !!data.disk;
        if (data.disk) {
            const used = fmtBytes(data.disk.usedBytes);
            const total = fmtBytes(data.disk.totalBytes);
            const free = fmtBytes(data.disk.freeBytes);
            blocks.disk.setName(`Disk ${data.disk.mount ?? '/'}`);
            blocks.disk.update({
                value: used.value,
                unit: `${used.unit} of ${total.value} ${total.unit}`,
                percent: data.disk.percent,
                severityClass: severity(data.disk.percent),
                detail: `${Math.round(data.disk.percent)}%   ·   ${free.value} ${free.unit} free`,
                sub: null,
            });
        }

        /* swap */
        blocks.swap.visible = !!data.swap?.totalBytes;
        if (data.swap?.totalBytes) {
            const used = fmtBytes(data.swap.usedBytes);
            const total = fmtBytes(data.swap.totalBytes);
            blocks.swap.update({
                value: used.value,
                unit: `${used.unit} of ${total.value} ${total.unit}`,
                percent: data.swap.percent,
                // Swap is not disk: any sustained use is worth noticing long
                // before it is anywhere near full.
                severityClass: severity(data.swap.percent, 25, 60),
                // Phrased exactly like Disk above it. Two rows that carry the
                // same kind of figure must read the same way.
                detail: `${Math.round(data.swap.percent)}%   ·   ${
                    fmtBytes(data.swap.totalBytes - data.swap.usedBytes).value} ${
                    fmtBytes(data.swap.totalBytes - data.swap.usedBytes).unit} free`,
                sub: null,
            });
        }

        /* rows */
        this._rows.aux.setKey(data.auxLabel ?? 'Temperature');
        this._rows.aux.set(data.auxDetail ?? '--', data.auxSeverity ?? '');

        this._rows.net.visible = !!data.net?.iface;
        if (data.net?.iface) {
            const rx = fmtRate(data.net.rxRate);
            const tx = fmtRate(data.net.txRate);
            this._rows.net.setKey(`Network ${data.net.iface}`);
            this._rows.net.set(`↓ ${rx.value} ${rx.unit}     ↑ ${tx.value} ${tx.unit}`);
        }

        this._rows.procs.visible = !!data.procs?.total;
        if (data.procs?.total) {
            // The key already says "Processes"; repeating the word in the value
            // is the same mistake as a button labelled "Click this button".
            this._rows.procs.set([
                `${data.procs.total}`,
                data.procs.threads ? `${data.procs.threads} threads` : null,
            ].filter(Boolean).join('   ·   '));
        }

        this._rows.uptime.visible = !!data.uptimeSeconds;
        if (data.uptimeSeconds)
            this._rows.uptime.set(fmtUptime(data.uptimeSeconds));
    }

    /* ── lifecycle ───────────────────────────────────────────────────────── */

    _restartTimer() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        const interval = Math.max(1, this._settings.get_int('poll-seconds'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    start() {
        this._renderPanel(null);
        this._refresh();
        this._restartTimer();
    }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
});

export default class SpyglassExtension extends Extension {
    enable() {
        this._indicator = new SpyglassIndicator(this);
        // Index 1 keeps it left of the system status area rather than fighting
        // it for the same slot.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
