// Pure data + formatting layer, deliberately free of any gnome-shell import.
//
// Everything here runs under plain `gjs`, which means sampling, parsing and
// shaping can be exercised for real before the Shell ever loads the extension.
// See test-lib.js in this directory.
//
// Both sources are shaped into the SAME record so the widget layer never has to
// know where a number came from. The only field that legitimately differs is
// `aux`, because the remote box is a VM with no thermal sensors.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const DECODER = new TextDecoder();

export const WARN = 80;
export const CRIT = 92;

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/* ── formatting ──────────────────────────────────────────────────────────── */

// Padded so the panel button does not resize as digits come and go. A label
// that jitters by a few pixels every three seconds is the kind of thing you
// cannot un-see once you have noticed it.
export function pct(v) {
    if (v === null || v === undefined || Number.isNaN(v))
        return ' --%';
    return `${Math.round(v).toString().padStart(2, ' ')}%`;
}

export function severity(v, warn = WARN, crit = CRIT) {
    if (v === null || v === undefined || Number.isNaN(v))
        return '';
    if (v >= crit)
        return 'wsm-crit';
    if (v >= warn)
        return 'wsm-warn';
    return '';
}

// Returns {value, unit} rather than a joined string so the UI can set the
// figure and its unit in two different weights.
export function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes))
        return {value: '--', unit: ''};
    const abs = Math.abs(bytes);
    if (abs >= GIB)
        return {value: (bytes / GIB).toFixed(1), unit: 'GiB'};
    if (abs >= MIB)
        return {value: (bytes / MIB).toFixed(0), unit: 'MiB'};
    if (abs >= KIB)
        return {value: (bytes / KIB).toFixed(0), unit: 'KiB'};
    return {value: `${Math.round(bytes)}`, unit: 'B'};
}

export function fmtRate(bytesPerSec) {
    const {value, unit} = fmtBytes(bytesPerSec);
    return {value, unit: unit ? `${unit}/s` : ''};
}

// Compact rate for the panel, where horizontal space is the scarce resource.
export function fmtRateShort(bytesPerSec) {
    if (bytesPerSec === null || bytesPerSec === undefined || Number.isNaN(bytesPerSec))
        return '--';
    if (bytesPerSec >= GIB)
        return `${(bytesPerSec / GIB).toFixed(1)}G`;
    if (bytesPerSec >= MIB)
        return `${(bytesPerSec / MIB).toFixed(bytesPerSec >= 10 * MIB ? 0 : 1)}M`;
    if (bytesPerSec >= KIB)
        return `${Math.round(bytesPerSec / KIB)}K`;
    return '0';
}

export function fmtUptime(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds))
        return '--';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

// Glances hands back a human string, either "9:50:25" or "1 day, 2:03:04".
export function parseGlancesUptime(text) {
    if (typeof text !== 'string')
        return null;
    let seconds = 0;
    const days = text.match(/(\d+)\s+day/);
    if (days)
        seconds += parseInt(days[1], 10) * 86400;
    const clock = text.match(/(\d+):(\d{2}):(\d{2})/);
    if (clock) {
        seconds += parseInt(clock[1], 10) * 3600;
        seconds += parseInt(clock[2], 10) * 60;
        seconds += parseInt(clock[3], 10);
    }
    return seconds || null;
}

/* ── plain readers ───────────────────────────────────────────────────────── */

export function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? DECODER.decode(bytes) : null;
    } catch (_e) {
        return null;
    }
}

// /proc/stat jiffies. Percentages need two samples, so this returns raw
// counters and the caller diffs them.
export function readCpuTimes() {
    const text = readFile('/proc/stat');
    if (!text)
        return null;
    const first = text.split('\n', 1)[0];
    const parts = first.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 5 || parts.some(Number.isNaN))
        return null;
    const [user, nice, system, idle, iowait, irq = 0, softirq = 0, steal = 0] = parts;
    return {
        user: user + nice,
        system: system + irq + softirq,
        idle,
        iowait,
        steal,
        busy: user + nice + system + irq + softirq + steal,
        total: user + nice + system + idle + iowait + irq + softirq + steal,
    };
}

function cpuDelta(now, prev) {
    if (!now || !prev)
        return null;
    const total = now.total - prev.total;
    if (total <= 0)
        return null;
    const share = key => Math.max(0, Math.min(100, ((now[key] - prev[key]) / total) * 100));
    return {
        percent: share('busy'),
        user: share('user'),
        system: share('system'),
        iowait: share('iowait'),
        steal: share('steal'),
    };
}

export function readMem() {
    const text = readFile('/proc/meminfo');
    if (!text)
        return null;
    const field = key => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
        return m ? parseInt(m[1], 10) * 1024 : null;
    };
    const total = field('MemTotal');
    const available = field('MemAvailable');
    if (!total || available === null)
        return null;
    const swapTotal = field('SwapTotal') ?? 0;
    const swapFree = field('SwapFree') ?? 0;
    return {
        mem: {
            percent: (1 - available / total) * 100,
            usedBytes: total - available,
            totalBytes: total,
            availBytes: available,
            cachedBytes: (field('Cached') ?? 0) + (field('Buffers') ?? 0),
        },
        swap: {
            percent: swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
            usedBytes: swapTotal - swapFree,
            totalBytes: swapTotal,
        },
    };
}

export function readLoad() {
    const text = readFile('/proc/loadavg');
    if (!text)
        return null;
    const p = text.trim().split(/\s+/);
    // 4th field is "running/total", which is a far cheaper process count than
    // walking every numeric directory in /proc on each tick.
    const procs = (p[3] ?? '').split('/');
    return {
        load: {min1: parseFloat(p[0]), min5: parseFloat(p[1]), min15: parseFloat(p[2])},
        procs: {
            running: parseInt(procs[0], 10) || null,
            total: parseInt(procs[1], 10) || null,
            threads: null,
        },
    };
}

export function readDisk(path = '/') {
    try {
        const info = Gio.File.new_for_path(path).query_filesystem_info(
            'filesystem::size,filesystem::free,filesystem::used', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        if (!size)
            return null;
        return {
            percent: ((size - free) / size) * 100,
            usedBytes: size - free,
            totalBytes: size,
            freeBytes: free,
            mount: path,
        };
    } catch (_e) {
        return null;
    }
}

export function readUptime() {
    const text = readFile('/proc/uptime');
    return text ? parseFloat(text.split(/\s+/)[0]) : null;
}

// The interface carrying the default route, found by reading the routing table
// rather than shelling out to `ip`.
export function defaultInterface() {
    const text = readFile('/proc/net/route');
    if (!text)
        return null;
    for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length > 1 && f[1] === '00000000')
            return f[0];
    }
    return null;
}

// Cumulative counters for one interface; rates come from diffing two reads.
export function readNetCounters(iface) {
    if (!iface)
        return null;
    const text = readFile('/proc/net/dev');
    if (!text)
        return null;
    for (const line of text.split('\n')) {
        const [name, rest] = line.split(':');
        if (!rest || name.trim() !== iface)
            continue;
        const f = rest.trim().split(/\s+/).map(Number);
        return {iface, rx: f[0], tx: f[8], at: GLib.get_monotonic_time()};
    }
    return null;
}

function netRates(now, prev) {
    if (!now || !prev || now.iface !== prev.iface)
        return {iface: now?.iface ?? null, rxRate: null, txRate: null};
    const elapsed = (now.at - prev.at) / 1e6;
    if (elapsed <= 0)
        return {iface: now.iface, rxRate: null, txRate: null};
    return {
        iface: now.iface,
        rxRate: Math.max(0, (now.rx - prev.rx) / elapsed),
        txRate: Math.max(0, (now.tx - prev.tx) / elapsed),
    };
}

// Package temperature. Scanned once and cached: hwmon numbering is stable for
// the life of a boot, and re-globbing /sys on every tick would be silly.
let _tempPathCache;
export function readTemp() {
    if (_tempPathCache === undefined) {
        _tempPathCache = null;
        for (let i = 0; i < 32; i++) {
            const name = readFile(`/sys/class/hwmon/hwmon${i}/name`);
            if (!name)
                continue;
            if (!['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(name.trim()))
                continue;
            const p = `/sys/class/hwmon/hwmon${i}/temp1_input`;
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
                _tempPathCache = p;
                break;
            }
        }
    }
    if (!_tempPathCache)
        return null;
    const raw = readFile(_tempPathCache);
    return raw ? parseInt(raw, 10) / 1000 : null;
}

// Vendors pad CPU model strings with trademark noise and a clock speed that is
// already wrong the moment the core boosts. The header has one line; spend it
// on the part that identifies the chip.
export function cleanCpuModel(raw) {
    if (!raw)
        return null;
    return raw
        .replace(/\((R|TM|r|tm)\)/g, '')
        .replace(/\b(CPU|Processor)\b/g, '')
        .replace(/@.*$/, '')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

let _staticLocal;
export function readLocalStatic() {
    if (_staticLocal)
        return _staticLocal;
    const cpuinfo = readFile('/proc/cpuinfo') ?? '';
    const osRelease = readFile('/etc/os-release') ?? '';
    const model = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
    const pretty = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?$/m);
    _staticLocal = {
        host: GLib.get_host_name().toLowerCase(),
        cpuModel: cleanCpuModel(model ? model[1] : null),
        cores: (cpuinfo.match(/^processor\s*:/gm) ?? []).length || null,
        os: pretty ? pretty[1] : null,
        kernel: (readFile('/proc/sys/kernel/osrelease') ?? '').trim() || null,
    };
    return _staticLocal;
}

/* ── GPU (local only; the workstation is a VM with no GPU) ───────────────── */

let _gpuAvailable;
export async function readLocalGpu(cancellable = null) {
    if (_gpuAvailable === false)
        return null;
    try {
        const proc = Gio.Subprocess.new(
            ['nvidia-smi',
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
                '--format=csv,noheader,nounits'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        if (!proc.get_successful() || !stdout)
            throw new Error('nvidia-smi failed');
        const [util, temp, used, total, ...name] = stdout.trim().split('\n')[0].split(',');
        _gpuAvailable = true;
        return {
            percent: parseFloat(util),
            temp: parseFloat(temp),
            usedBytes: parseFloat(used) * MIB,
            totalBytes: parseFloat(total) * MIB,
            name: name.join(',').trim() || null,
        };
    } catch (_e) {
        // Absent or broken nvidia-smi is a permanent condition, not a blip:
        // stop paying for a subprocess every tick once it has failed.
        _gpuAvailable = false;
        return null;
    }
}

/* ── local source ────────────────────────────────────────────────────────── */

// `prev` carries the counters from the previous tick: {cpu, net}. Returns
// {data, sample} so the caller can feed `sample` back in next time.
export function buildLocalData(prev = {}) {
    const nowCpu = readCpuTimes();
    const iface = defaultInterface();
    const nowNet = readNetCounters(iface);
    const memory = readMem();
    const loadInfo = readLoad();
    const disk = readDisk('/');
    const temp = readTemp();
    const stat = readLocalStatic();

    const cpu = cpuDelta(nowCpu, prev.cpu) ?? {
        percent: null, user: null, system: null, iowait: null, steal: null,
    };

    return {
        sample: {cpu: nowCpu, net: nowNet},
        data: {
            ok: true,
            kind: 'local',
            host: stat.host,
            os: stat.os,
            kernel: stat.kernel,
            cpuModel: stat.cpuModel,
            cores: stat.cores,
            uptimeSeconds: readUptime(),
            cpu,
            // Real silicon here, so the third panel slot is a temperature.
            aux: temp === null ? '' : `${Math.round(temp)}°`,
            auxLabel: 'Temperature',
            auxDetail: temp === null ? 'not available' : `${temp.toFixed(1)} °C`,
            auxSeverity: temp === null ? '' : severity(temp, 80, 90),
            temp,
            mem: memory?.mem ?? null,
            swap: memory?.swap ?? null,
            disk,
            net: netRates(nowNet, prev.net),
            load: loadInfo?.load ?? null,
            procs: loadInfo?.procs ?? null,
            gpu: null, // filled in asynchronously by readLocalGpu
        },
    };
}

/* ── remote source ───────────────────────────────────────────────────────── */

export async function fetchJson(session, url, cancellable) {
    const msg = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    if (msg.get_status() !== Soup.Status.OK)
        throw new Error(`HTTP ${msg.get_status()} for ${url}`);
    return JSON.parse(DECODER.decode(bytes.get_data()));
}

// Glances reports every interface; the useful one is whichever is actually
// moving bytes, excluding loopback and virtual bridges.
function pickInterface(list) {
    if (!Array.isArray(list) || list.length === 0)
        return null;
    const candidates = list.filter(n => {
        const name = n.interface_name ?? '';
        return name !== 'lo' && !/^(docker|br-|veth|virbr)/.test(name);
    });
    const pool = candidates.length ? candidates : list;
    return pool.reduce((best, n) =>
        (n.bytes_all_rate_per_sec ?? 0) > (best.bytes_all_rate_per_sec ?? 0) ? n : best, pool[0]);
}

export function buildRemoteData({cpu, mem, memswap, fs, network, load, uptime, processcount, system}) {
    const root = Array.isArray(fs) ? fs.find(f => f.mnt_point === '/') ?? fs[0] : null;
    const nic = pickInterface(network);
    const io = cpu?.iowait ?? 0;
    const steal = cpu?.steal ?? 0;

    return {
        ok: true,
        kind: 'remote',
        host: system?.hostname ?? null,
        os: system?.linux_distro ?? system?.os_name ?? null,
        kernel: system?.os_version ?? null,
        cpuModel: null,
        cores: load?.cpucore ?? null,
        uptimeSeconds: parseGlancesUptime(uptime),
        cpu: {
            percent: cpu?.total ?? null,
            user: cpu?.user ?? null,
            system: cpu?.system ?? null,
            iowait: cpu?.iowait ?? null,
            steal: cpu?.steal ?? null,
        },
        // No thermals exist inside a VM, so this slot carries the two figures
        // that actually predict trouble on this box instead.
        aux: `${Math.round(io)}·${Math.round(steal)}`,
        // The label names the two figures so the value does not have to repeat
        // them. "iowait 0.0%  steal 0.0%" next to a key reading "io · steal"
        // says everything twice.
        auxLabel: 'iowait · steal',
        auxDetail: `${io.toFixed(1)}%   ·   ${steal.toFixed(1)}%`,
        auxSeverity: steal >= 10 || io >= 40 ? 'wsm-crit' : steal >= 3 || io >= 20 ? 'wsm-warn' : '',
        temp: null,
        mem: mem
            ? {
                percent: mem.percent,
                usedBytes: mem.used,
                totalBytes: mem.total,
                availBytes: mem.available,
                cachedBytes: mem.cached ?? null,
            }
            : null,
        swap: memswap
            ? {percent: memswap.percent, usedBytes: memswap.used, totalBytes: memswap.total}
            : null,
        disk: root
            ? {
                percent: root.percent,
                usedBytes: root.used,
                totalBytes: root.size,
                freeBytes: root.free,
                mount: root.mnt_point,
            }
            : null,
        net: nic
            ? {
                iface: nic.interface_name,
                rxRate: nic.bytes_recv_rate_per_sec ?? null,
                txRate: nic.bytes_sent_rate_per_sec ?? null,
            }
            : {iface: null, rxRate: null, txRate: null},
        load: load ? {min1: load.min1, min5: load.min5, min15: load.min15} : null,
        procs: processcount
            ? {total: processcount.total, running: processcount.running, threads: processcount.thread}
            : null,
        gpu: null,
    };
}

// ONE request per poll, deliberately.
//
// The first version fetched six plugins in parallel every three seconds. A
// single-worker uvicorn accumulated CLOSE-WAIT sockets under that load and
// wedged completely, refusing even 127.0.0.1 and ignoring SIGTERM. Reading the
// whole machine in one request is both correct and roughly a sixth of the
// connection churn.
//
// This assumes the agent runs with the expensive plugins disabled, which is
// what the shipped unit file does:
//   glances -w -B 0.0.0.0 -p 61208 --disable-plugin processlist,programlist,…
// Without that, /all still works but carries a process table nobody reads.
export async function fetchRemoteData(session, base, cancellable) {
    return buildRemoteData(await fetchJson(session, `${base}/all`, cancellable));
}
