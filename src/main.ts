/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for projectors and displays speaking PJLink Class 1 and
 * Class 2 (TCP/UDP 4352), with no dependency beyond adapter-core.
 *
 * One instance drives any number of projectors, each in its own device folder.
 * Every projector is polled over short TCP sessions (see lib/pjlink.ts). Class 2
 * projectors also push status notifications to UDP 4352, and can be found by a
 * broadcast search; only one process per host can own that port, which is why
 * one instance handles all projectors (see lib/udp.ts).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as utils from '@iobroker/adapter-core';
import {
    PjlinkClient,
    PjlinkError,
    PowerStatus,
    ReplyTimeoutError,
    inputLabel,
    isInputCode,
    parseAvMute,
    parseErrorStatus,
    parseInputList,
    parseLamps,
    type ErrorStatus,
    type PjlinkSession,
} from './lib/pjlink';
import { PjlinkUdp, type Notification } from './lib/udp';

/** Object ids that belong to the instance itself and cannot name a projector. */
const RESERVED_IDS = ['info'];

/** How long a power command may go unconfirmed before control.power follows the projector again. */
const POWER_CONFIRM_MS = 30_000;

/** How long a search collects answers. */
const SEARCH_WAIT_MS = 10_000;

const POWER_STATES = { 0: 'Off', 1: 'On', 2: 'Cooling', 3: 'Warming' };
const FAULT_STATES = { 0: 'OK', 1: 'Warning', 2: 'Error' };
const FAULTS: [keyof ErrorStatus, string][] = [
    ['fan', 'Fan'],
    ['lamp', 'Lamp'],
    ['temperature', 'Temperature'],
    ['coverOpen', 'Cover open'],
    ['filter', 'Filter'],
    ['other', 'Other'],
];

/** One row of the projector table in the instance configuration. */
interface DeviceConfig {
    enabled?: boolean;
    name?: string;
    host?: string;
    port?: number;
}

/** A configured projector and its runtime state. */
interface Projector {
    /** object-tree id, e.g. "thistle_1" */
    id: string;
    label: string;
    host: string;
    /** resolved IP address, used to match UDP notifications */
    address: string;
    client: PjlinkClient;
    /** PJLink class, 0 until known */
    cls: number;
    /** commands answered with ERR1, not asked again */
    unsupported: Set<string>;
    inputs: string[];
    lampCount: number;
    connected: boolean;
    polling: boolean;
    /** time of the next full (information) poll */
    nextInfo: number;
    /** a power command that the projector has not confirmed yet */
    pendingPower?: { on: boolean; fromStatus: number; until: number };
    powerStatus?: number;
    /** the last poll failure, so a repeated one is not logged as a warning again */
    lastPollError?: string;
    pollTimer?: ioBroker.Interval;
    refreshTimer?: ioBroker.Timeout;
}

type Updates = [string, ioBroker.StateValue][];

class PjlinkClass2 extends utils.Adapter {
    private projectors = new Map<string, Projector>();
    private udp?: PjlinkUdp;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'pjlink-class2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        await this.buildProjectors();
        await this.removeStaleObjects();
        for (const p of this.projectors.values()) {
            await this.createBaseObjects(p);
        }
        this.subscribeStates('*');

        if (this.config.notifications) {
            this.udp = new PjlinkUdp(n => void this.onNotification(n));
            try {
                await this.udp.open();
                this.log.info('Listening for PJLink Class 2 notifications and search replies on UDP 4352');
            } catch (error) {
                this.log.warn(
                    `Cannot listen on UDP 4352 (${(error as Error).message}); Class 2 notifications and search ` +
                        `are disabled, polling continues. Is another PJLink controller or instance running on this host?`,
                );
                this.udp = undefined;
            }
        }

        if (!this.projectors.size) {
            this.log.warn('No projectors configured — open the instance settings and add at least one.');
            return;
        }
        const interval = Math.max(1, Number(this.config.pollInterval) || 5) * 1000;
        let stagger = 0;
        for (const p of this.projectors.values()) {
            // spread the projectors out so they are not polled in one burst
            p.refreshTimer = this.setTimeout(() => void this.poll(p), stagger);
            stagger += 250;
            p.pollTimer = this.setInterval(() => void this.poll(p), interval);
        }
    }

    /** Turn the configured projector table into runtime projectors. */
    private async buildProjectors(): Promise<void> {
        const devices = (this.config.devices ?? []) as unknown as DeviceConfig[];
        for (const device of devices) {
            const host = (device.host || '').trim();
            if (device.enabled === false) {
                continue;
            }
            if (!host) {
                this.log.warn(`Ignoring projector "${device.name || '(unnamed)'}": no host configured.`);
                continue;
            }
            const label = (device.name || '').trim() || host;
            const id = this.makeId(label);
            const port = Number(device.port) || 4352;
            let address = host;
            if (!isIP(host)) {
                address = await lookup(host, { family: 4 }).then(
                    r => r.address,
                    () => host,
                );
            }
            this.projectors.set(id, {
                id,
                label,
                host,
                address,
                client: new PjlinkClient({ host, port, password: this.config.password }),
                cls: 0,
                unsupported: new Set(),
                inputs: [],
                lampCount: 0,
                connected: false,
                polling: false,
                nextInfo: 0,
            });
            this.log.info(`Projector "${label}" -> ${this.namespace}.${id} (${host}:${port})`);
        }
    }

    /**
     * Derive a unique object id from a projector name. Lower case, so that names
     * differing only in case do not fork into two object trees.
     *
     * @param label - projector name or host
     */
    private makeId(label: string): string {
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '_')
                .replace(/^_+|_+$/g, '') || 'projector';
        let id = RESERVED_IDS.includes(base) ? `${base}_projector` : base;
        for (let suffix = 2; this.projectors.has(id); suffix++) {
            id = `${base}_${suffix}`;
        }
        return id;
    }

    /** Delete device folders of projectors that are no longer configured. */
    private async removeStaleObjects(): Promise<void> {
        for (const obj of await this.getDevicesAsync()) {
            const id = obj._id.substring(this.namespace.length + 1);
            if (!id.includes('.') && !this.projectors.has(id)) {
                this.log.info(`Removing objects of projector "${id}", which is no longer configured.`);
                await this.delObjectAsync(id, { recursive: true });
            }
        }
    }

    private async createChannelObject(id: string, name: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
    }

    private async createStateObject(id: string, common: Partial<ioBroker.StateCommon>): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: { read: true, write: false, ...common } as ioBroker.StateCommon,
            native: {},
        });
    }

    /**
     * Create the Class 1 object tree of one projector.
     *
     * @param p - the projector
     */
    private async createBaseObjects(p: Projector): Promise<void> {
        await this.extendObjectAsync(p.id, { type: 'device', common: { name: p.label }, native: {} });
        await this.createChannelObject(`${p.id}.info`, 'Information');
        await this.createChannelObject(`${p.id}.control`, 'Control');
        await this.createChannelObject(`${p.id}.status`, 'Status');
        await this.createChannelObject(`${p.id}.status.errors`, 'Error status');

        const i = `${p.id}.info`;
        await this.createStateObject(`${i}.connection`, {
            name: 'Projector connected',
            type: 'boolean',
            role: 'indicator.connected',
            def: false,
        });
        await this.createStateObject(`${i}.class`, { name: 'PJLink class', type: 'number', role: 'value' });
        await this.createStateObject(`${i}.name`, { name: 'Projector name (NAME)', type: 'string', role: 'info.name' });
        await this.createStateObject(`${i}.manufacturer`, {
            name: 'Manufacturer (INF1)',
            type: 'string',
            role: 'text',
        });
        await this.createStateObject(`${i}.model`, { name: 'Product name (INF2)', type: 'string', role: 'info.model' });
        await this.createStateObject(`${i}.other`, { name: 'Other information (INFO)', type: 'string', role: 'text' });
        await this.createStateObject(`${i}.inputs`, {
            name: 'Available inputs (code -> name)',
            type: 'string',
            role: 'json',
        });
        await this.createStateObject(`${i}.lastError`, {
            name: 'Last command error',
            type: 'string',
            role: 'text',
            def: '',
        });

        const c = `${p.id}.control`;
        await this.createStateObject(`${c}.power`, {
            name: 'Power',
            type: 'boolean',
            role: 'switch.power',
            write: true,
            def: false,
        });
        await this.createStateObject(`${c}.input`, { name: 'Input', type: 'string', role: 'media.input', write: true });
        await this.createStateObject(`${c}.videoMute`, {
            name: 'Video mute',
            type: 'boolean',
            role: 'switch',
            write: true,
        });
        await this.createStateObject(`${c}.audioMute`, {
            name: 'Audio mute',
            type: 'boolean',
            role: 'media.mute',
            write: true,
        });

        await this.createStateObject(`${p.id}.status.power`, {
            name: 'Power status',
            type: 'number',
            role: 'value',
            states: POWER_STATES,
        });
        for (const [key, name] of FAULTS) {
            await this.createStateObject(`${p.id}.status.errors.${key}`, {
                name,
                type: 'number',
                role: 'value',
                states: FAULT_STATES,
            });
        }
    }

    /**
     * Create the Class 2 additions, once the projector has reported Class 2.
     *
     * @param p - the projector
     */
    private async createClass2Objects(p: Projector): Promise<void> {
        const i = `${p.id}.info`;
        await this.createStateObject(`${i}.serialNumber`, {
            name: 'Serial number (SNUM)',
            type: 'string',
            role: 'info.serial',
        });
        await this.createStateObject(`${i}.softwareVersion`, {
            name: 'Software version (SVER)',
            type: 'string',
            role: 'info.firmware',
        });
        await this.createStateObject(`${i}.macAddress`, { name: 'MAC address', type: 'string', role: 'info.mac' });
        await this.createStateObject(`${i}.lampModel`, {
            name: 'Replacement lamp model (RLMP)',
            type: 'string',
            role: 'text',
        });
        await this.createStateObject(`${i}.filterModel`, {
            name: 'Replacement filter model (RFIL)',
            type: 'string',
            role: 'text',
        });
        await this.createStateObject(`${i}.recommendedResolution`, {
            name: 'Recommended resolution (RRES)',
            type: 'string',
            role: 'text',
        });

        const c = `${p.id}.control`;
        await this.createStateObject(`${c}.freeze`, { name: 'Freeze', type: 'boolean', role: 'switch', write: true });
        for (const [key, name, role] of [
            ['volumeUp', 'Speaker volume up', 'button.volume.up'],
            ['volumeDown', 'Speaker volume down', 'button.volume.down'],
            ['microphoneUp', 'Microphone volume up', 'button'],
            ['microphoneDown', 'Microphone volume down', 'button'],
        ]) {
            await this.createStateObject(`${c}.${key}`, { name, type: 'boolean', role, read: false, write: true });
        }

        await this.createStateObject(`${p.id}.status.inputResolution`, {
            name: 'Input signal resolution (IRES)',
            type: 'string',
            role: 'text',
        });
        await this.createStateObject(`${p.id}.status.filterHours`, {
            name: 'Filter usage time (FILT)',
            type: 'number',
            role: 'value',
            unit: 'h',
        });
    }

    /**
     * Create lamp states for lamps the projector has just reported.
     *
     * @param p - the projector
     * @param count - number of lamps reported
     */
    private async createLampObjects(p: Projector, count: number): Promise<void> {
        await this.createChannelObject(`${p.id}.status.lamps`, 'Lamps');
        for (let n = p.lampCount + 1; n <= count; n++) {
            await this.createChannelObject(`${p.id}.status.lamps.${n}`, `Lamp ${n}`);
            await this.createStateObject(`${p.id}.status.lamps.${n}.hours`, {
                name: `Lamp ${n} hours`,
                type: 'number',
                role: 'value',
                unit: 'h',
            });
            await this.createStateObject(`${p.id}.status.lamps.${n}.on`, {
                name: `Lamp ${n} on`,
                type: 'boolean',
                role: 'indicator',
            });
        }
        p.lampCount = count;
    }

    /**
     * Send a query and return its value, or undefined if the projector cannot
     * answer it now. A command answered with ERR1 is not asked again.
     *
     * @param p - the projector
     * @param s - the open session
     * @param cls - PJLink class of the command
     * @param command - four-letter command
     * @param param - parameter, "?" by default
     */
    private async query(
        p: Projector,
        s: PjlinkSession,
        cls: 1 | 2,
        command: string,
        param = '?',
    ): Promise<string | undefined> {
        const key = `${cls}${command}${param}`;
        if (p.unsupported.has(key)) {
            return undefined;
        }
        try {
            return await s.send(cls, command, param);
        } catch (error) {
            if (error instanceof ReplyTimeoutError && cls === 2) {
                // seen on an NEC NP3250 (Class 1): Class 2 commands get no answer at all, not ERR1
                this.log.info(`[${p.label}] did not answer %2${command}; not asking again`);
                p.unsupported.add(key);
                return undefined;
            }
            if (!(error instanceof PjlinkError) || error.code === 'ERRA') {
                throw error;
            }
            if (error.code === 'ERR1') {
                this.log.info(`[${p.label}] does not support ${command}; not asking again`);
                p.unsupported.add(key);
            } else {
                this.log.debug(`[${p.label}] ${error.message}`);
            }
            return undefined;
        }
    }

    /**
     * Poll one projector for its status and, when due, its information.
     *
     * @param p - the projector to poll
     */
    private async poll(p: Projector): Promise<void> {
        if (p.polling) {
            return;
        }
        p.polling = true;
        const full = !p.connected || Date.now() >= p.nextInfo;
        const updates: Updates = [];
        try {
            await p.client.session(async s => {
                if (!p.cls) {
                    const cls = await this.query(p, s, 1, 'CLSS');
                    // unanswered (ERR3/ERR4): ask again next poll, Class 1 until then
                    if (cls !== undefined || p.unsupported.has('1CLSS?')) {
                        p.cls = cls === '2' ? 2 : 1;
                        if (p.cls === 2) {
                            await this.createClass2Objects(p);
                        }
                        updates.push(['info.class', p.cls]);
                    }
                }
                const c2 = p.cls === 2;
                const inputClass = c2 ? 2 : 1;

                const power = await this.query(p, s, 1, 'POWR');
                if (power !== undefined && /^[0-3]$/.test(power)) {
                    updates.push(...this.powerUpdates(p, Number(power)));
                }
                const input = await this.query(p, s, inputClass, 'INPT');
                if (input !== undefined) {
                    updates.push(['control.input', input.toUpperCase()]);
                }
                const avmt = await this.query(p, s, 1, 'AVMT');
                const mute = avmt === undefined ? undefined : parseAvMute(avmt);
                if (mute) {
                    updates.push(['control.videoMute', mute.video], ['control.audioMute', mute.audio]);
                }
                const erst = await this.query(p, s, 1, 'ERST');
                const errors = erst === undefined ? undefined : parseErrorStatus(erst);
                if (errors) {
                    updates.push(...this.errorUpdates(errors));
                }
                if (c2) {
                    const freeze = await this.query(p, s, 2, 'FREZ');
                    if (freeze !== undefined) {
                        updates.push(['control.freeze', freeze === '1']);
                    }
                    const ires = await this.query(p, s, 2, 'IRES');
                    if (ires !== undefined) {
                        updates.push(['status.inputResolution', ires]);
                    }
                }
                if (full) {
                    await this.pollInfo(p, s, updates);
                }
            });
            if (full) {
                p.nextInfo = Date.now() + Math.max(10, Number(this.config.infoInterval) || 300) * 1000;
            }
            for (const [id, val] of updates) {
                await this.setState(`${p.id}.${id}`, { val, ack: true });
            }
            p.lastPollError = undefined;
            await this.setConnected(p, true);
        } catch (error) {
            // warn when the reason changes (e.g. a missing password), not on every poll
            const message = (error as Error).message;
            if (message !== p.lastPollError) {
                this.log.warn(`[${p.label}] poll failed: ${message}`);
                p.lastPollError = message;
            } else {
                this.log.debug(`[${p.label}] poll failed: ${message}`);
            }
            await this.setConnected(p, false);
        } finally {
            p.polling = false;
        }
    }

    /**
     * The slow-changing part of a poll: identity, inputs, lamps and Class 2 details.
     *
     * @param p - the projector
     * @param s - the open session
     * @param updates - collects the state updates
     */
    private async pollInfo(p: Projector, s: PjlinkSession, updates: Updates): Promise<void> {
        const c2 = p.cls === 2;
        for (const [command, id] of [
            ['NAME', 'info.name'],
            ['INF1', 'info.manufacturer'],
            ['INF2', 'info.model'],
            ['INFO', 'info.other'],
        ]) {
            const value = await this.query(p, s, 1, command);
            if (value !== undefined) {
                updates.push([id, value]);
            }
        }

        const inst = await this.query(p, s, c2 ? 2 : 1, 'INST');
        if (inst !== undefined) {
            const inputs = parseInputList(inst);
            const names: Record<string, string> = {};
            for (const code of inputs) {
                const name = c2 ? await this.query(p, s, 2, 'INNM', `?${code}`) : undefined;
                names[code] = name ? `${name} (${inputLabel(code)})` : inputLabel(code);
            }
            if (inputs.join() !== p.inputs.join()) {
                p.inputs = inputs;
                await this.extendObjectAsync(`${p.id}.control.input`, { common: { states: names } });
            }
            updates.push(['info.inputs', JSON.stringify(names)]);
        }

        const lamp = await this.query(p, s, 1, 'LAMP');
        if (lamp !== undefined) {
            const lamps = parseLamps(lamp);
            if (lamps.length > p.lampCount) {
                await this.createLampObjects(p, lamps.length);
            }
            lamps.forEach((l, n) => {
                updates.push([`status.lamps.${n + 1}.hours`, l.hours], [`status.lamps.${n + 1}.on`, l.on]);
            });
        }

        if (c2) {
            for (const [command, id] of [
                ['SNUM', 'info.serialNumber'],
                ['SVER', 'info.softwareVersion'],
                ['RLMP', 'info.lampModel'],
                ['RFIL', 'info.filterModel'],
                ['RRES', 'info.recommendedResolution'],
            ]) {
                const value = await this.query(p, s, 2, command);
                if (value !== undefined) {
                    updates.push([id, value]);
                }
            }
            const filt = await this.query(p, s, 2, 'FILT');
            if (filt !== undefined && /^\d+$/.test(filt)) {
                updates.push(['status.filterHours', Number(filt)]);
            }
        }
    }

    /**
     * State updates for a power status, holding control.power at a just-sent
     * command until the projector confirms it. Projectors can report the old
     * status for several seconds after accepting a command (an NEC NP3250
     * reports Off for ~12 s after power-on), and some accept a power-on and then
     * silently ignore it, e.g. during a rest period after cooling down.
     *
     * @param p - the projector
     * @param status - power status, 0-3
     */
    private powerUpdates(p: Projector, status: number): Updates {
        p.powerStatus = status;
        let on = status === PowerStatus.ON || status === PowerStatus.WARMING;
        const pending = p.pendingPower;
        if (pending) {
            if (status !== pending.fromStatus) {
                p.pendingPower = undefined;
            } else if (Date.now() < pending.until) {
                on = pending.on;
            } else {
                p.pendingPower = undefined;
                const message =
                    `Power ${pending.on ? 'on' : 'off'} was accepted, but the projector has not changed state ` +
                    `within ${POWER_CONFIRM_MS / 1000} s — it may be refusing (e.g. a rest period after cooling down)`;
                this.log.warn(`[${p.label}] ${message}`);
                return [
                    ['status.power', status],
                    ['control.power', on],
                    ['info.lastError', message],
                ];
            }
        }
        return [
            ['status.power', status],
            ['control.power', on],
        ];
    }

    private errorUpdates(e: ErrorStatus): Updates {
        return FAULTS.map(([key]) => [`status.errors.${key}`, e[key]]);
    }

    /**
     * Track the reachability of one projector; info.connection of the instance
     * reports whether any projector is answering.
     *
     * @param p - the projector
     * @param connected - whether it just answered
     */
    private async setConnected(p: Projector, connected: boolean): Promise<void> {
        if (p.connected !== connected) {
            this.log.info(`[${p.label}] ${connected ? 'connected' : 'not reachable'}`);
        }
        p.connected = connected;
        await this.setState(`${p.id}.info.connection`, { val: connected, ack: true });
        const any = [...this.projectors.values()].some(x => x.connected);
        await this.setState('info.connection', { val: any, ack: true });
    }

    /**
     * Apply a Class 2 status notification to the projector it came from.
     *
     * @param n - the notification
     */
    private async onNotification(n: Notification): Promise<void> {
        const p = [...this.projectors.values()].find(x => x.address === n.address);
        if (!p) {
            this.log.debug(`Ignoring ${n.command}=${n.value} from unconfigured ${n.address}`);
            return;
        }
        this.log.debug(`[${p.label}] notification ${n.command}=${n.value}`);
        let updates: Updates = [];
        switch (n.command) {
            case 'POWR':
                if (/^[0-3]$/.test(n.value)) {
                    updates = this.powerUpdates(p, Number(n.value));
                }
                break;
            case 'INPT':
                if (isInputCode(n.value)) {
                    updates = [['control.input', n.value.toUpperCase()]];
                }
                break;
            case 'ERST': {
                const errors = parseErrorStatus(n.value);
                if (errors) {
                    updates = this.errorUpdates(errors);
                }
                break;
            }
            case 'LKUP':
                // the projector has just come onto the network: read everything
                // the JBMIA test tool sends a placeholder "xx:xx:xx:xx:xx:xx"
                if (p.cls === 2 && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.value)) {
                    updates = [['info.macAddress', n.value.toLowerCase()]];
                }
                p.nextInfo = 0;
                this.refreshSoon(p, 0);
                break;
        }
        for (const [id, val] of updates) {
            await this.setState(`${p.id}.${id}`, { val, ack: true });
        }
    }

    /**
     * Poll a projector shortly, e.g. after a command.
     *
     * @param p - the projector
     * @param delayMs - delay before polling
     */
    private refreshSoon(p: Projector, delayMs: number): void {
        if (p.refreshTimer) {
            this.clearTimeout(p.refreshTimer);
        }
        p.refreshTimer = this.setTimeout(() => void this.poll(p), delayMs);
    }

    /**
     * Is called if a subscribed state changes.
     *
     * @param id - State ID
     * @param state - State object
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const rel = id.substring(`${this.namespace}.`.length);
        const separator = rel.indexOf('.');
        const p = separator > 0 ? this.projectors.get(rel.substring(0, separator)) : undefined;
        if (!p) {
            return;
        }
        const key = rel.substring(separator + 1);
        let request: [1 | 2, string, string];
        switch (key) {
            case 'control.power':
                request = [1, 'POWR', state.val ? '1' : '0'];
                break;
            case 'control.input': {
                const code = String(state.val ?? '').toUpperCase();
                if (!isInputCode(code) || (p.cls !== 2 && !/^[1-5][1-9]$/.test(code))) {
                    const message = `"${code}" is not a valid PJLink Class ${p.cls || 1} input code`;
                    this.log.warn(`[${p.label}] ${message}`);
                    await this.setState(`${p.id}.info.lastError`, { val: message, ack: true });
                    this.refreshSoon(p, 0); // put the real input back
                    return;
                }
                request = [p.cls === 2 ? 2 : 1, 'INPT', code];
                break;
            }
            case 'control.videoMute':
                request = [1, 'AVMT', state.val ? '11' : '10'];
                break;
            case 'control.audioMute':
                request = [1, 'AVMT', state.val ? '21' : '20'];
                break;
            case 'control.freeze':
                request = [2, 'FREZ', state.val ? '1' : '0'];
                break;
            case 'control.volumeUp':
                request = [2, 'SVOL', '1'];
                break;
            case 'control.volumeDown':
                request = [2, 'SVOL', '0'];
                break;
            case 'control.microphoneUp':
                request = [2, 'MVOL', '1'];
                break;
            case 'control.microphoneDown':
                request = [2, 'MVOL', '0'];
                break;
            default:
                this.log.warn(`Unhandled writable state: ${id}`);
                return;
        }

        try {
            await p.client.send(...request);
            if (key === 'control.power') {
                p.pendingPower = {
                    on: Boolean(state.val),
                    fromStatus: p.powerStatus ?? -1,
                    until: Date.now() + POWER_CONFIRM_MS,
                };
            }
            await this.setState(id, { val: state.val, ack: true });
            await this.setState(`${p.id}.info.lastError`, { val: '', ack: true });
        } catch (error) {
            this.log.warn(`[${p.label}] ${key} failed: ${(error as Error).message}`);
            await this.setState(`${p.id}.info.lastError`, { val: (error as Error).message, ack: true });
        }
        // read back, so the tree reflects the projector rather than the request
        this.refreshSoon(p, 500);
    }

    /**
     * Serve the "search" button of the admin UI.
     * Requires "common.messagebox": true in io-package.json.
     *
     * @param obj - the incoming message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (typeof obj !== 'object' || !obj.command) {
            return;
        }
        const reply = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };
        if (obj.command === 'discover') {
            try {
                reply(await this.discover());
            } catch (error) {
                reply({ error: (error as Error).message });
            }
        } else {
            reply({ error: `unknown command "${obj.command}"` });
        }
    }

    /**
     * Broadcast a Class 2 search and merge the answers into the configured
     * projector table, which the admin UI then offers to save.
     */
    private async discover(): Promise<Record<string, unknown>> {
        if (!this.udp) {
            return { error: 'search needs the UDP 4352 listener — enable notifications and check the log' };
        }
        const broadcast = (this.config.broadcastAddress || '255.255.255.255')
            .split(/[\s,]+/)
            .filter(a => isIP(a) === 4);
        this.log.info(`Searching for PJLink Class 2 projectors via ${broadcast.join(', ')}...`);
        const hits = await this.udp.search(broadcast, SEARCH_WAIT_MS, ms => this.delay(ms));

        const devices = [...((this.config.devices ?? []) as unknown as DeviceConfig[])];
        const known = new Set(devices.map(d => (d.host || '').trim()));
        for (const p of this.projectors.values()) {
            known.add(p.address);
        }
        let added = 0;
        for (const hit of hits) {
            let name = '';
            try {
                const client = new PjlinkClient({ host: hit.address, password: this.config.password });
                name = await client.send(1, 'NAME', '?');
            } catch {
                // the address is enough to add it
            }
            this.log.info(`Found ${hit.address} (${hit.mac})${name ? ` "${name}"` : ''}`);
            if (known.has(hit.address)) {
                continue;
            }
            devices.push({ enabled: true, name, host: hit.address, port: 4352 });
            added++;
        }
        this.log.info(`Search finished: ${hits.length} projector(s) answered, ${added} added to the table.`);
        return {
            native: { ...this.config, devices },
            saveConfig: true,
            result: `${hits.length} projector(s) found, ${added} added`,
        };
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            for (const p of this.projectors.values()) {
                if (p.pollTimer) {
                    this.clearInterval(p.pollTimer);
                }
                if (p.refreshTimer) {
                    this.clearTimeout(p.refreshTimer);
                }
                p.client.close();
            }
            this.udp?.close();
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PjlinkClass2(options);
} else {
    // otherwise start the instance directly
    (() => new PjlinkClass2())();
}
