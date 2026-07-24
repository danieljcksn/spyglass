import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpyglassPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Monitor',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        window.add(page);

        /* ── remote ──────────────────────────────────────────────────────── */

        const remote = new Adw.PreferencesGroup({
            title: 'Remote machine',
            description: 'Reads a Glances agent over HTTP. On the remote box: ' +
                'glances -w -B 0.0.0.0 -p 61208',
        });
        page.add(remote);

        const host = new Adw.EntryRow({title: 'Address'});
        settings.bind('remote-host', host, 'text', Gio.SettingsBindFlags.DEFAULT);
        remote.add(host);

        const label = new Adw.EntryRow({title: 'Short name'});
        settings.bind('remote-label', label, 'text', Gio.SettingsBindFlags.DEFAULT);
        remote.add(label);

        const port = new Adw.SpinRow({
            title: 'Port',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 65535, step_increment: 1}),
        });
        settings.bind('remote-port', port, 'value', Gio.SettingsBindFlags.DEFAULT);
        remote.add(port);

        /* ── sampling ────────────────────────────────────────────────────── */

        const sampling = new Adw.PreferencesGroup({
            title: 'Sampling',
            description: 'Only the machine currently being displayed is polled.',
        });
        page.add(sampling);

        const poll = new Adw.SpinRow({
            title: 'Interval',
            subtitle: 'Seconds between samples',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('poll-seconds', poll, 'value', Gio.SettingsBindFlags.DEFAULT);
        sampling.add(poll);

        /* ── panel ───────────────────────────────────────────────────────── */

        const panel = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Which figures appear in the top bar. Everything stays ' +
                'available in the menu regardless.',
        });
        page.add(panel);

        for (const [key, title, subtitle] of [
            ['cpu', 'Processor', null],
            ['aux', 'Temperature', 'Falls back to io · steal on a machine with no thermal sensors, such as a VM'],
            ['ram', 'Memory', null],
            ['disk', 'Disk', 'Shown as used, not free'],
            ['gpu', 'Graphics', 'Local machine only, and only when a GPU is detected'],
            ['net', 'Network', 'Throughput down and up'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
            settings.bind(`panel-show-${key}`, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            panel.add(row);
        }
    }
}
