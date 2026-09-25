/*
 * PJLink Class 1 / Class 2 protocol: parsers and a TCP client.
 *
 * TCP 4352, lines terminated by CR. On connect the projector greets with
 *   "PJLINK 0"            no authentication
 *   "PJLINK 1 <random>"   authentication: the first command is prefixed with a
 *                         hex digest of <random> + password: md5 in older
 *                         projectors, sha256 in newer ones (the JBMIA test
 *                         tool PJLinkTEST4CNT accepts only sha256). The greeting
 *                         does not say which, so the client tries one, retries
 *                         with the other on ERRA, and remembers the one that worked.
 * Commands are "%<class><CMD> <param>", replies "%<class><CMD>=<value>".
 * The value is "OK" for a successful set, or ERR1 (undefined command),
 * ERR2 (out of parameter), ERR3 (unavailable time) or ERR4 (projector
 * failure). A failed authentication is answered with "PJLINK ERRA".
 *
 * Projectors close idle connections after about 30 s and many accept only one
 * connection at a time, so the client holds no connection open: every poll or
 * command runs in a short session (connect, greeting, commands, close), and
 * sessions are serialised per projector.
 */
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

export const PJLINK_PORT = 4352;

/** Power status reported by POWR ? */
export const PowerStatus = {
    OFF: 0,
    ON: 1,
    COOLING: 2,
    WARMING: 3,
} as const;

/** PJLink input types; the first character of an input code. */
export const INPUT_TYPES: Record<string, string> = {
    1: 'RGB',
    2: 'Video',
    3: 'Digital',
    4: 'Storage',
    5: 'Network',
    6: 'Internal',
};

const ERROR_TEXT: Record<string, string> = {
    ERR1: 'undefined command',
    ERR2: 'out of parameter',
    ERR3: 'unavailable time',
    ERR4: 'projector/display failure',
    ERRA: 'authentication failed',
};

/** A PJLink error reply (ERR1-4, ERRA). */
export class PjlinkError extends Error {
    /**
     * @param code - ERR1, ERR2, ERR3, ERR4 or ERRA
     * @param command - the command that failed, e.g. "POWR 1"
     */
    public constructor(
        public readonly code: string,
        public readonly command: string,
    ) {
        super(`${command}: ${code} (${ERROR_TEXT[code] ?? 'unknown error'})`);
        this.name = 'PjlinkError';
    }
}

/** No reply arrived in time. */
export class ReplyTimeoutError extends Error {
    /** @param timeoutMs - the timeout that expired */
    public constructor(timeoutMs: number) {
        super(`no reply within ${timeoutMs} ms`);
        this.name = 'ReplyTimeoutError';
    }
}

/** Fault summary reported by ERST: 0 = ok, 1 = warning, 2 = error. */
export interface ErrorStatus {
    /** fan fault */
    fan: number;
    /** lamp fault */
    lamp: number;
    /** temperature fault */
    temperature: number;
    /** cover open */
    coverOpen: number;
    /** filter fault */
    filter: number;
    /** other fault */
    other: number;
}

/** One lamp as reported by LAMP ? */
export interface Lamp {
    /** lamp usage time in hours */
    hours: number;
    /** true if the lamp is lit */
    on: boolean;
}

/** Video and audio mute as reported by AVMT ? */
export interface AvMute {
    /** true if video is muted */
    video: boolean;
    /** true if audio is muted */
    audio: boolean;
}

/** Hash used for the authentication digest. */
export type DigestAlgorithm = 'md5' | 'sha256';

/**
 * The authentication digest of the projector's random number and the password.
 *
 * @param random - random number from the "PJLINK 1 <random>" greeting
 * @param password - the projector's PJLink password
 * @param algorithm - md5 (older projectors) or sha256 (newer ones)
 */
export function authDigest(random: string, password: string, algorithm: DigestAlgorithm = 'md5'): string {
    return createHash(algorithm)
        .update(random + password, 'utf8')
        .digest('hex');
}

/**
 * Parse a reply line such as "%1POWR=1" or "%2ACKN=00:11:22:33:44:55".
 *
 * @param line - one line without the terminating CR
 */
export function parseReply(line: string): { cls: number; command: string; value: string } | undefined {
    const m = /^%([12])([A-Z0-9]{4})=(.*)$/i.exec(line);
    return m ? { cls: Number(m[1]), command: m[2].toUpperCase(), value: m[3] } : undefined;
}

/**
 * Parse ERST ?, six digits: fan, lamp, temperature, cover open, filter, other.
 * Undefined if malformed.
 *
 * @param value - reply value, e.g. "000010"
 */
export function parseErrorStatus(value: string): ErrorStatus | undefined {
    if (!/^[0-2]{6}$/.test(value)) {
        return undefined;
    }
    const d = [...value].map(Number);
    return { fan: d[0], lamp: d[1], temperature: d[2], coverOpen: d[3], filter: d[4], other: d[5] };
}

/**
 * Parse LAMP ?, pairs of "<hours> <on>" for up to eight lamps; empty if malformed.
 *
 * @param value - reply value, e.g. "1163 1" or "100 1 250 0"
 */
export function parseLamps(value: string): Lamp[] {
    const parts = value.trim().split(/\s+/);
    if (parts.length % 2 || parts.some(p => !/^\d+$/.test(p))) {
        return [];
    }
    const lamps: Lamp[] = [];
    for (let i = 0; i < parts.length; i += 2) {
        lamps.push({ hours: Number(parts[i]), on: parts[i + 1] === '1' });
    }
    return lamps;
}

/**
 * Parse AVMT ?: "11" video mute, "21" audio mute, "31" both, "30" neither.
 * Undefined if malformed.
 *
 * @param value - reply value
 */
export function parseAvMute(value: string): AvMute | undefined {
    const m = /^([123])([01])$/.exec(value);
    if (!m) {
        return undefined;
    }
    const on = m[2] === '1';
    return { video: on && m[1] !== '2', audio: on && m[1] !== '1' };
}

/**
 * Parse INST ?, a space separated list of input codes.
 *
 * @param value - reply value, e.g. "11 12 31 32"
 */
export function parseInputList(value: string): string[] {
    return value
        .trim()
        .split(/\s+/)
        .filter(code => isInputCode(code))
        .map(code => code.toUpperCase());
}

/**
 * Whether a string is a valid input code: type 1-6, then 1-9 (Class 1) or 1-9/A-Z (Class 2).
 *
 * @param code - candidate input code
 */
export function isInputCode(code: string): boolean {
    return /^[1-6][1-9A-Z]$/i.test(code);
}

/**
 * A readable name for an input code, e.g. "31" -> "Digital 1".
 *
 * @param code - input code
 */
export function inputLabel(code: string): string {
    return `${INPUT_TYPES[code[0]] ?? 'Input'} ${code[1]}`;
}

/** An open PJLink connection, handed to a session callback. */
export interface PjlinkSession {
    /**
     * Send a command and resolve with the reply value. Rejects with a
     * PjlinkError on an ERR reply.
     *
     * @param cls - 1 or 2
     * @param command - four-letter command, e.g. "POWR"
     * @param param - parameter, "?" for a query
     */
    send(cls: 1 | 2, command: string, param: string): Promise<string>;
}

/** Options for a PJLink client. */
export interface PjlinkClientOptions {
    /** IP address or host name */
    host: string;
    /** TCP port, 4352 by default */
    port?: number;
    /** PJLink password, used when the projector asks for one */
    password?: string;
    /** Timeout for the connection, the greeting and each reply, in ms. */
    timeoutMs?: number;
}

/** PJLink TCP client for one projector. */
export class PjlinkClient {
    public readonly host: string;
    public readonly port: number;
    private readonly password: string;
    private readonly timeoutMs: number;
    private queue: Promise<unknown> = Promise.resolve();
    private active?: Socket;
    private algorithm: DigestAlgorithm = 'md5';

    /** @param options - connection options */
    public constructor(options: PjlinkClientOptions) {
        this.host = options.host;
        this.port = options.port || PJLINK_PORT;
        this.password = options.password ?? '';
        this.timeoutMs = options.timeoutMs ?? 5000;
    }

    /**
     * Run a session: connect, handle the greeting, run the callback, close.
     * Sessions are serialised, so a poll and a command never overlap.
     *
     * @param fn - uses the session to send commands
     */
    public session<T>(fn: (session: PjlinkSession) => Promise<T>): Promise<T> {
        const run = this.queue.then(() => this.authenticatedSession(fn));
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Send one command in a session of its own.
     *
     * @param cls - 1 or 2
     * @param command - four-letter command
     * @param param - parameter, "?" for a query
     */
    public send(cls: 1 | 2, command: string, param: string): Promise<string> {
        return this.session(s => s.send(cls, command, param));
    }

    /** The digest algorithm that authentication currently uses. */
    public get digestAlgorithm(): DigestAlgorithm {
        return this.algorithm;
    }

    /** Abort the running session, if any. */
    public close(): void {
        this.active?.destroy();
    }

    private async authenticatedSession<T>(fn: (session: PjlinkSession) => Promise<T>): Promise<T> {
        try {
            return await this.runSession(fn, this.algorithm);
        } catch (error) {
            // ERRA answers the first command, so fn has not acted on any reply yet
            if (!(error instanceof PjlinkError && error.code === 'ERRA')) {
                throw error;
            }
            const other: DigestAlgorithm = this.algorithm === 'md5' ? 'sha256' : 'md5';
            const result = await this.runSession(fn, other);
            this.algorithm = other;
            return result;
        }
    }

    private async runSession<T>(fn: (session: PjlinkSession) => Promise<T>, algorithm: DigestAlgorithm): Promise<T> {
        const socket = new Socket();
        this.active = socket;
        const lines = new LineReader(socket, this.timeoutMs);
        try {
            await new Promise<void>((resolve, reject) => {
                // the socket's own inactivity timer, which also runs while connecting
                const onTimeout = (): void => reject(new Error(`connection to ${this.host}:${this.port} timed out`));
                const done = (): void => {
                    socket.off('timeout', onTimeout);
                    socket.setTimeout(0);
                };
                socket.setTimeout(this.timeoutMs);
                socket.once('timeout', onTimeout);
                socket.once('connect', () => {
                    done();
                    resolve();
                });
                socket.once('error', err => {
                    done();
                    reject(err);
                });
                socket.connect(this.port, this.host);
            });

            const greeting = await lines.next();
            let prefix = '';
            const auth = /^PJLINK ([01])(?: (\S+))?$/i.exec(greeting);
            if (!auth) {
                throw new Error(
                    /ERRA/i.test(greeting)
                        ? 'authentication failed'
                        : `unexpected greeting "${greeting}" — not a PJLink device?`,
                );
            }
            if (auth[1] === '1') {
                if (!this.password) {
                    throw new Error('the projector requires a PJLink password, but none is configured');
                }
                prefix = authDigest(auth[2] ?? '', this.password, algorithm);
            }

            const session: PjlinkSession = {
                send: async (cls, command, param) => {
                    const request = `%${cls}${command} ${param}`;
                    socket.write(`${prefix}${request}\r`);
                    prefix = ''; // the digest goes with the first command only
                    for (;;) {
                        const line = await lines.next();
                        if (/^PJLINK ERRA$/i.test(line)) {
                            throw new PjlinkError('ERRA', request);
                        }
                        const reply = parseReply(line);
                        if (reply?.command !== command.toUpperCase()) {
                            continue; // stray line, e.g. a greeting echoed by a proxy
                        }
                        const code = reply.value.toUpperCase();
                        if (code in ERROR_TEXT) {
                            throw new PjlinkError(code, `${command} ${param}`);
                        }
                        return reply.value;
                    }
                },
            };
            return await fn(session);
        } finally {
            lines.dispose();
            // destroy rather than end: a half-closed socket still delivers late
            // errors (ECONNRESET), which would be uncaught once our listeners are gone
            socket.destroy();
            if (this.active === socket) {
                this.active = undefined;
            }
        }
    }
}

/** Reads CR-terminated lines from a socket, with a per-line timeout. */
class LineReader {
    private buffer = '';
    private lines: string[] = [];
    private waiter?: { resolve: (line: string) => void; reject: (err: Error) => void };
    private failure?: Error;
    private readonly onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString('utf8');
        const parts = this.buffer.split(/\r\n?|\n/);
        this.buffer = parts.pop() ?? '';
        for (const part of parts) {
            if (part.trim()) {
                this.lines.push(part.trim());
            }
        }
        this.deliver();
    };
    private readonly onError = (err: Error): void => this.fail(err);
    private readonly onClose = (): void => this.fail(new Error('connection closed by the projector'));
    private readonly onTimeout = (): void => {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.reject(new ReplyTimeoutError(this.timeoutMs));
    };

    /**
     * @param socket - socket to read from
     * @param timeoutMs - how long to wait for each line
     */
    public constructor(
        private readonly socket: Socket,
        private readonly timeoutMs: number,
    ) {
        socket.on('data', this.onData);
        socket.on('error', this.onError);
        socket.on('close', this.onClose);
        socket.on('timeout', this.onTimeout);
    }

    /** Resolve with the next line. */
    public next(): Promise<string> {
        return new Promise((resolve, reject) => {
            // the socket's inactivity timer (see onTimeout), armed only while a reply is awaited
            const disarm = (): void => void this.socket.setTimeout(0);
            this.socket.setTimeout(this.timeoutMs);
            this.waiter = {
                resolve: line => {
                    disarm();
                    resolve(line);
                },
                reject: err => {
                    disarm();
                    reject(err);
                },
            };
            this.deliver();
        });
    }

    /** Stop listening. An error listener stays attached so a late error cannot go uncaught. */
    public dispose(): void {
        this.socket.off('data', this.onData);
        this.socket.off('close', this.onClose);
        this.socket.off('error', this.onError);
        this.socket.off('timeout', this.onTimeout);
        this.socket.on('error', () => undefined);
    }

    private deliver(): void {
        if (!this.waiter) {
            return;
        }
        const waiter = this.waiter;
        if (this.lines.length) {
            this.waiter = undefined;
            waiter.resolve(this.lines.shift()!);
        } else if (this.failure) {
            this.waiter = undefined;
            waiter.reject(this.failure);
        }
    }

    private fail(err: Error): void {
        this.failure ??= err;
        this.deliver();
    }
}
