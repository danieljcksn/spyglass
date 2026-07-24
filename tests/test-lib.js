#!/usr/bin/env -S gjs -m
//
// Exercises lib.js for real, outside gnome-shell:
//
//   gjs -m test-lib.js
//
// Local sampling hits /proc, /sys and nvidia-smi directly; the remote half
// performs actual HTTP against the Glances agent. If this passes, the only
// thing left that can break inside the Shell is the widget layer.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {
    buildLocalData, buildRemoteData, cleanCpuModel, fetchRemoteData,
    defaultInterface, fmtBytes, fmtRate, fmtRateShort, fmtUptime,
    parseGlancesUptime, pct, readCpuTimes, readLocalGpu, readLocalStatic,
    readDisk, readLoad, readMem, readNetCounters, readTemp, readUptime, severity,
} from '../src/lib.js';

const BASE = ARGV[0] ?? GLib.getenv('WSM_TEST_HOST') ?? 'http://127.0.0.1:61208/api/4';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
    checks++;
    if (!condition)
        failures++;
    print(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

const isPct = v => typeof v === 'number' && v >= 0 && v <= 100;

print('── formatting ─────────────────────────────────────────');
check('pct pads single digits', pct(6) === ' 6%', `"${pct(6)}"`);
check('pct handles 100', pct(100) === '100%');
check('pct handles null', pct(null) === ' --%');
check('severity clean below warn', severity(50) === '');
check('severity warns at 85', severity(85) === 'wsm-warn');
check('severity crits at 95', severity(95) === 'wsm-crit');
check('severity honours custom bounds', severity(50, 40, 75) === 'wsm-warn');

check('fmtBytes GiB', fmtBytes(33699287040).value === '31.4', JSON.stringify(fmtBytes(33699287040)));
check('fmtBytes GiB unit', fmtBytes(33699287040).unit === 'GiB');
check('fmtBytes MiB', fmtBytes(5 * 1048576).unit === 'MiB');
check('fmtBytes KiB', fmtBytes(2048).unit === 'KiB');
check('fmtBytes bytes', fmtBytes(512).unit === 'B');
check('fmtBytes null safe', fmtBytes(null).value === '--');
check('fmtRate appends /s', fmtRate(2048).unit === 'KiB/s');
check('fmtRateShort K', fmtRateShort(92723) === '91K', fmtRateShort(92723));
check('fmtRateShort M', fmtRateShort(5 * 1048576) === '5.0M', fmtRateShort(5 * 1048576));
check('fmtRateShort zero', fmtRateShort(12) === '0');

check('fmtUptime minutes', fmtUptime(600) === '10m', fmtUptime(600));
check('fmtUptime hours', fmtUptime(35400) === '9h 50m', fmtUptime(35400));
check('fmtUptime days', fmtUptime(111072) === '1d 6h 51m', fmtUptime(111072));
check('parseGlancesUptime clock', parseGlancesUptime('9:50:25') === 35425);
check('parseGlancesUptime with days', parseGlancesUptime('1 day, 2:03:04') === 93784);
check('parseGlancesUptime junk', parseGlancesUptime(null) === null);

check('cleanCpuModel strips trademarks',
    cleanCpuModel('12th Gen Intel(R) Core(TM) i5-12450HX') === '12th Gen Intel Core i5-12450HX',
    cleanCpuModel('12th Gen Intel(R) Core(TM) i5-12450HX'));
check('cleanCpuModel strips clock and CPU',
    cleanCpuModel('Intel(R) Xeon(R) CPU E5-2680 v3 @ 2.50GHz') === 'Intel Xeon E5-2680 v3',
    cleanCpuModel('Intel(R) Xeon(R) CPU E5-2680 v3 @ 2.50GHz'));
check('cleanCpuModel null safe', cleanCpuModel(null) === null);

print('\n── local readers ──────────────────────────────────────');
const cpu1 = readCpuTimes();
check('readCpuTimes counters', cpu1 !== null && cpu1.total > 0);
check('readCpuTimes busy < total', cpu1.busy < cpu1.total);

const memory = readMem();
check('readMem percent in range', isPct(memory?.mem.percent), `${memory?.mem.percent.toFixed(1)}%`);
check('readMem totals in bytes', memory?.mem.totalBytes > 1e9,
    `${(memory?.mem.totalBytes / 1073741824).toFixed(1)} GiB`);
check('readMem used+avail == total', memory
    && Math.abs(memory.mem.usedBytes + memory.mem.availBytes - memory.mem.totalBytes) < 2);
check('readMem swap present', memory?.swap.totalBytes > 0,
    `${(memory?.swap.totalBytes / 1073741824).toFixed(1)} GiB`);
check('readMem reports cache', memory?.mem.cachedBytes > 0);

const disk = readDisk('/');
check('readDisk percent in range', isPct(disk?.percent), `${disk?.percent.toFixed(1)}%`);
check('readDisk used+free == total', disk
    && Math.abs(disk.usedBytes + disk.freeBytes - disk.totalBytes) < 2);

const loadInfo = readLoad();
check('readLoad min1 numeric', typeof loadInfo?.load.min1 === 'number');
check('readLoad process total', loadInfo?.procs.total > 10, `${loadInfo?.procs.total}`);

check('readUptime positive', readUptime() > 0, `${fmtUptime(readUptime())}`);
check('readTemp finds coretemp', readTemp() > 10 && readTemp() < 120, `${readTemp()} C`);

const iface = defaultInterface();
check('defaultInterface found', typeof iface === 'string' && iface.length > 0, iface);
check('readNetCounters returns bytes', readNetCounters(iface)?.rx >= 0);

const stat = readLocalStatic();
check('static host', typeof stat.host === 'string' && stat.host.length > 0, stat.host);
check('static cores', stat.cores > 0, `${stat.cores}`);
check('static cpu model', typeof stat.cpuModel === 'string', stat.cpuModel);
check('static os', typeof stat.os === 'string', stat.os);

print('\n── local aggregate (two samples, 1s apart) ─────────────');
const first = buildLocalData({});
check('first sample has no cpu delta yet', first.data.cpu.percent === null);
check('first sample still has memory', isPct(first.data.mem.percent));
check('first sample carries counters', !!first.sample.cpu && !!first.sample.net);

const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
    const second = buildLocalData(first.sample);
    const d = second.data;

    check('cpu percent computed', isPct(d.cpu.percent), `${d.cpu.percent?.toFixed(1)}%`);
    check('cpu breakdown present', isPct(d.cpu.user) && isPct(d.cpu.system) && isPct(d.cpu.iowait));
    check('cpu parts do not exceed total', d.cpu.user + d.cpu.system <= d.cpu.percent + 1);
    check('aux is a temperature', /°$/.test(d.aux), `"${d.aux}"`);
    check('net rates computed', d.net.rxRate !== null && d.net.txRate !== null,
        `${d.net.iface} ↓${fmtRateShort(d.net.rxRate)} ↑${fmtRateShort(d.net.txRate)}`);
    check('uptime present', d.uptimeSeconds > 0, fmtUptime(d.uptimeSeconds));
    check('kind is local', d.kind === 'local');

    print('\n── gpu (nvidia-smi) ───────────────────────────────────');
    readLocalGpu(null).then(gpu => {
        if (gpu) {
            check('gpu percent in range', isPct(gpu.percent), `${gpu.percent}%`);
            check('gpu temp sane', gpu.temp > 10 && gpu.temp < 120, `${gpu.temp} C`);
            check('gpu vram totals', gpu.totalBytes > 1e9,
                `${(gpu.usedBytes / 1048576).toFixed(0)} / ${(gpu.totalBytes / 1048576).toFixed(0)} MiB`);
            check('gpu name', typeof gpu.name === 'string' && gpu.name.length > 0, gpu.name);
        } else {
            check('gpu absent handled cleanly', gpu === null, '(no nvidia-smi)');
        }
        runRemote();
        return undefined;
    }).catch(e => {
        check('gpu read', false, e.message);
        runRemote();
    });

    return GLib.SOURCE_REMOVE;
});

function runRemote() {
    print('\n── remote shaping (fixture) ───────────────────────────');
    const shaped = buildRemoteData({
        cpu: {total: 13.7, user: 7.9, system: 5.2, iowait: 13.1, steal: 0.0},
        mem: {percent: 34.3, used: 11547750400, total: 33699287040, available: 22151536640, cached: 20288974848},
        memswap: {percent: 3.2, used: 275251200, total: 8589930496},
        fs: [{mnt_point: '/', percent: 73.2, used: 35735154688, size: 51460472832, free: 13078085632}],
        network: [
            {interface_name: 'lo', bytes_all_rate_per_sec: 9e9},
            {interface_name: 'docker0', bytes_all_rate_per_sec: 5e8},
            {interface_name: 'ens160', bytes_recv_rate_per_sec: 92723, bytes_sent_rate_per_sec: 72455, bytes_all_rate_per_sec: 165178},
        ],
        load: {min1: 15.38, min5: 13.52, min15: 9.36, cpucore: 24},
        uptime: '9:50:25',
        processcount: {total: 603, running: 1, thread: 1377},
        system: {hostname: 'work', linux_distro: 'Ubuntu 24.04', os_version: '6.8.0-136-generic'},
    });

    check('remote cpu passthrough', shaped.cpu.percent === 13.7);
    check('remote aux is io·steal', shaped.aux === '13·0', `"${shaped.aux}"`);
    check('remote picks / from fs list', Math.round(shaped.disk.percent) === 73);
    check('remote disk absolutes', shaped.disk.totalBytes === 51460472832);
    check('remote mem in bytes', shaped.mem.totalBytes === 33699287040);
    check('remote swap shaped', Math.round(shaped.swap.percent) === 3);
    check('remote skips lo and docker0', shaped.net.iface === 'ens160', shaped.net.iface);
    check('remote net rates', shaped.net.rxRate === 92723 && shaped.net.txRate === 72455);
    check('remote uptime parsed', shaped.uptimeSeconds === 35425, fmtUptime(shaped.uptimeSeconds));
    check('remote procs', shaped.procs.total === 603 && shaped.procs.threads === 1377);
    check('remote host from system', shaped.host === 'work');
    check('remote cores from load', shaped.cores === 24);
    check('remote kind', shaped.kind === 'remote');
    check('remote has no gpu', shaped.gpu === null);

    print('\n── remote live (real HTTP to the workstation) ──────────');
    const session = new Soup.Session({timeout: 6});
    const cancellable = new Gio.Cancellable();

    fetchRemoteData(session, BASE, cancellable)
        .then(d => {
            check('live cpu in range', isPct(d.cpu.percent), `${d.cpu.percent}%`);
            check('live mem in range', isPct(d.mem.percent), `${d.mem.percent}%`);
            check('live mem absolutes', d.mem.totalBytes > 1e9,
                `${fmtBytes(d.mem.usedBytes).value} / ${fmtBytes(d.mem.totalBytes).value} GiB`);
            check('live disk in range', isPct(d.disk.percent), `${d.disk.percent}%`);
            check('live disk absolutes', d.disk.totalBytes > 1e9,
                `${fmtBytes(d.disk.freeBytes).value} GiB free`);
            check('live swap present', d.swap !== null);
            check('live net interface', typeof d.net.iface === 'string', d.net.iface);
            check('live load cores', d.cores > 0, `${d.cores} cores`);
            check('live uptime parsed', d.uptimeSeconds > 0, fmtUptime(d.uptimeSeconds));
            check('live procs counted', d.procs?.total > 0, `${d.procs?.total} processes`);
            check('live host', typeof d.host === 'string', d.host);
            return undefined;
        })
        .catch(e => check('live fetch', false, e.message))
        .finally(() => {
            print(`\n${failures === 0 ? `ALL ${checks} CHECKS PASS` : `${failures} of ${checks} FAILED`}`);
            loop.quit();
        });
}

loop.run();
