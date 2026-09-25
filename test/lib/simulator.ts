/*
 * A PJLink projector simulator for tests and for trying the adapter without
 * hardware. Not part of the adapter build.
 *
 * Standalone:  npx ts-node test/lib/simulator.ts [port] [class] [password]
 *   e.g.       npx ts-node test/lib/simulator.ts 4353 2 secret
 */
import { createSocket } from 'node:dgram';
import { createServer, type Server, type Socket } from 'node:net';
import { authDigest, type DigestAlgorithm } from '../../src/lib/pjlink';

/** Simulated projector state; tests read and change it directly. */
export interface SimState {
    /** power status, 0-3 */
    power: number;
    /** current input code */
    input: string;
    /** available input codes */
    inputs: string[];
    /** input code -> terminal name */
    inputNames: Record<string, string>;
    /** video mute */
    videoMute: boolean;
    /** audio mute */
    audioMute: boolean;
    /** freeze */
    freeze: boolean;
    /** ERST digits */
    errors: string;
    /** LAMP reply */
    lamps: string;
    /** NAME reply */
    name: string;
    /** INF1 reply */
    manufacturer: string;
    /** INF2 reply */
    model: string;
    /** other fault */
    other: string;
    /** SNUM reply */
    serial: string;
    /** SVER reply */
    software: string;
    /** IRES reply */
    inputResolution: string;
    /** RRES reply */
    recommendedResolution: string;
    /** FILT reply */
    filterHours: number;
    /** RLMP reply */
    lampModel: string;
    /** RFIL reply */
    filterModel: string;
    /** speaker volume steps */
    volume: number;
    /** microphone volume steps */
    microphone: number;
}

/** Simulator options. */
export interface SimOptions {
    /** PJLink class to emulate */
    cls?: 1 | 2;
    /** PJLink password, used when the projector asks for one */
    password?: string;
    /** commands answered with ERR1, e.g. to mimic a projector without FREZ */
    unsupported?: string[];
    /** authentication digest the simulator expects, md5 by default */
    digest?: DigestAlgorithm;
    /** commands that get no answer at all, as an NEC NP3250 does with every Class 2 command */
    ignored?: string[];
}

/** A simulated PJLink projector. */
export class PjlinkSimulator {
    public readonly state: SimState = {
        power: 0,
        input: '31',
        inputs: ['11', '12', '31', '32'],
        inputNames: { 11: 'Computer 1', 12: 'Computer 2', 31: 'HDMI 1', 32: 'HDMI 2' },
        videoMute: false,
        audioMute: false,
        freeze: false,
        errors: '000000',
        lamps: '1163 0',
        name: 'Simulated projector',
        manufacturer: 'SIM',
        model: 'PJ-2000',
        other: 'simulator',
        serial: 'SN123456',
        software: '1.0.0',
        inputResolution: '1920x1080',
        recommendedResolution: '1920x1200',
        filterHours: 250,
        lampModel: 'LMP-1',
        filterModel: 'FLT-1',
        volume: 10,
        microphone: 5,
    };
    /** every command line received, without the auth digest */
    public readonly received: string[] = [];
    public readonly cls: 1 | 2;
    private readonly password: string;
    private readonly unsupported: Set<string>;
    private readonly ignored: Set<string>;
    private readonly digest: DigestAlgorithm;
    /** number of TCP connections accepted */
    public connections = 0;
    private server?: Server;
    private readonly sockets = new Set<Socket>();

    /** @param options - simulator options */
    public constructor(options: SimOptions = {}) {
        this.cls = options.cls ?? 2;
        this.password = options.password ?? '';
        this.unsupported = new Set(options.unsupported ?? []);
        this.ignored = new Set(options.ignored ?? []);
        this.digest = options.digest ?? 'md5';
    }

    /**
     * Start listening; resolves with the port.
     *
     * @param port - TCP port, 0 for any free port
     */
    public listen(port = 0): Promise<number> {
        return new Promise(resolve => {
            this.server = createServer(socket => this.accept(socket));
            this.server.listen(port, '127.0.0.1', () => {
                const address = this.server!.address();
                resolve(typeof address === 'object' && address ? address.port : port);
            });
        });
    }

    /** Stop listening and drop every connection. */
    public close(): Promise<void> {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    }

    /**
     * Send a Class 2 status notification, like a real projector would.
     *
     * @param port - the controller's UDP port
     * @param line - e.g. "%2POWR=1"
     */
    public notify(port: number, line: string): Promise<void> {
        const socket = createSocket('udp4');
        return new Promise(resolve => socket.send(`${line}\r`, port, '127.0.0.1', () => socket.close(() => resolve())));
    }

    private accept(socket: Socket): void {
        this.sockets.add(socket);
        this.connections++;
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
        const random = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
        let authenticated = !this.password;
        socket.write(this.password ? `PJLINK 1 ${random}\r` : 'PJLINK 0\r');

        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\r');
            buffer = lines.pop() ?? '';
            for (let line of lines) {
                if (!authenticated) {
                    const digest = authDigest(random, this.password, this.digest);
                    if (line.slice(0, digest.length) !== digest) {
                        socket.end('PJLINK ERRA\r');
                        return;
                    }
                    authenticated = true;
                    line = line.slice(digest.length);
                }
                this.received.push(line);
                if (!this.ignored.has(line.slice(2, 6))) {
                    socket.write(`${this.answer(line)}\r`);
                }
            }
        });
    }

    private answer(line: string): string {
        const m = /^%([12])([A-Z0-9]{4}) ?(.*)$/.exec(line);
        if (!m) {
            return '%1ERR1';
        }
        const [, clsText, cmd, param] = m;
        const cls = Number(clsText);
        const head = `%${cls}${cmd}=`;
        if (cls > this.cls || this.unsupported.has(cmd)) {
            return `${head}ERR1`;
        }
        const s = this.state;
        const query = param === '?';
        const on = s.power === 1;
        switch (cmd) {
            case 'POWR':
                if (query) {
                    return `${head}${s.power}`;
                }
                if (param !== '0' && param !== '1') {
                    return `${head}ERR2`;
                }
                if (s.power === 2 || s.power === 3) {
                    return `${head}ERR3`;
                }
                s.power = param === '1' ? 1 : 0;
                return `${head}OK`;
            case 'INPT':
                if (query) {
                    return on ? `${head}${s.input}` : `${head}ERR3`;
                }
                if (!s.inputs.includes(param)) {
                    return `${head}ERR2`;
                }
                if (!on) {
                    return `${head}ERR3`;
                }
                s.input = param;
                return `${head}OK`;
            case 'AVMT': {
                if (query) {
                    if (s.videoMute && s.audioMute) {
                        return `${head}31`;
                    }
                    return `${head}${s.videoMute ? '11' : s.audioMute ? '21' : '30'}`;
                }
                const mm = /^([123])([01])$/.exec(param);
                if (!mm) {
                    return `${head}ERR2`;
                }
                if (mm[1] !== '2') {
                    s.videoMute = mm[2] === '1';
                }
                if (mm[1] !== '1') {
                    s.audioMute = mm[2] === '1';
                }
                return `${head}OK`;
            }
            case 'FREZ':
                if (query) {
                    return `${head}${s.freeze ? 1 : 0}`;
                }
                s.freeze = param === '1';
                return `${head}OK`;
            case 'SVOL':
            case 'MVOL': {
                const key = cmd === 'SVOL' ? 'volume' : 'microphone';
                if (param !== '0' && param !== '1') {
                    return `${head}ERR2`;
                }
                s[key] += param === '1' ? 1 : -1;
                return `${head}OK`;
            }
            case 'INNM': {
                const code = param.replace(/^\?/, '');
                return s.inputNames[code] ? `${head}${s.inputNames[code]}` : `${head}ERR2`;
            }
        }
        if (!query) {
            return `${head}ERR2`;
        }
        const values: Record<string, string> = {
            ERST: s.errors,
            LAMP: s.lamps,
            INST: s.inputs.join(' '),
            NAME: s.name,
            INF1: s.manufacturer,
            INF2: s.model,
            INFO: s.other,
            CLSS: String(this.cls),
            SNUM: s.serial,
            SVER: s.software,
            IRES: on ? s.inputResolution : '-',
            RRES: s.recommendedResolution,
            FILT: String(s.filterHours),
            RLMP: s.lampModel,
            RFIL: s.filterModel,
        };
        return cmd in values ? `${head}${values[cmd]}` : `${head}ERR1`;
    }
}

if (require.main === module) {
    const [port = '4352', cls = '2', password = ''] = process.argv.slice(2);
    const sim = new PjlinkSimulator({ cls: cls === '1' ? 1 : 2, password });
    void sim.listen(Number(port)).then(p => {
        console.log(`PJLink Class ${sim.cls} simulator on 127.0.0.1:${p}${password ? ' (password set)' : ''}`);
    });
}
