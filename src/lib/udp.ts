/*
 * PJLink Class 2 over UDP 4352: search and status notifications.
 *
 * Search: the controller broadcasts "%2SRCH" to UDP 4352; every Class 2
 * projector answers "%2ACKN=<mac>" to UDP 4352 of the controller.
 *
 * Status notifications, sent by Class 2 projectors to UDP 4352 of the
 * controller unprompted:
 *   %2LKUP=<mac>      network link came up (projector just started)
 *   %2ERST=<6 digits> error status changed
 *   %2POWR=<0|1|2|3>  power status changed
 *   %2INPT=<code>     input changed
 *
 * Both arrive on the controller's port 4352, so a host can only have one
 * listener: one adapter instance owns the port for all its projectors.
 * Class 1 projectors do neither; they are only reachable by polling.
 */
import { createSocket, type Socket } from 'node:dgram';
import { PJLINK_PORT, parseReply } from './pjlink';

/** A Class 2 status notification. */
export interface Notification {
    /** source address of the datagram */
    address: string;
    /** LKUP, ERST, POWR or INPT */
    command: string;
    /** the value after "=" */
    value: string;
}

/** A projector that answered a search. */
export interface SearchHit {
    /** source address of the reply */
    address: string;
    /** MAC address from the ACKN reply */
    mac: string;
}

/** Listens on UDP 4352 for search replies and status notifications. */
export class PjlinkUdp {
    private socket?: Socket;
    private searchHits?: Map<string, SearchHit>;

    /**
     * @param onNotification - called for every status notification
     * @param port - UDP port to listen on (4352; tests use another)
     */
    public constructor(
        private readonly onNotification: (n: Notification) => void,
        private readonly port = PJLINK_PORT,
    ) {}

    /**
     * Bind the port.
     *
     * @param address - local address to bind, e.g. "0.0.0.0"
     */
    public open(address = '0.0.0.0'): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = createSocket({ type: 'udp4', reuseAddr: false });
            socket.once('error', reject);
            socket.on('message', (msg, rinfo) => this.handle(msg.toString('utf8'), rinfo.address));
            socket.bind(this.port, address, () => {
                socket.off('error', reject);
                socket.on('error', () => undefined); // send errors are reported by send()
                socket.setBroadcast(true);
                this.socket = socket;
                resolve();
            });
        });
    }

    /** Close the port. */
    public close(): void {
        this.socket?.close();
        this.socket = undefined;
    }

    /**
     * Broadcast a search and collect the answers.
     *
     * @param broadcast - broadcast addresses to send to
     * @param waitMs - how long to collect answers
     * @param delay - waits the given ms (the adapter's managed delay)
     */
    public async search(
        broadcast: string[],
        waitMs: number,
        delay: (ms: number) => Promise<void>,
    ): Promise<SearchHit[]> {
        const socket = this.socket;
        if (!socket) {
            throw new Error(`UDP port ${this.port} is not open, so search is unavailable`);
        }
        if (this.searchHits) {
            throw new Error('a search is already running');
        }
        this.searchHits = new Map();
        try {
            for (const address of broadcast) {
                await new Promise<void>((resolve, reject) =>
                    socket.send('%2SRCH\r', this.port, address, err => (err ? reject(err) : resolve())),
                );
            }
            await delay(waitMs);
            return [...this.searchHits.values()];
        } finally {
            this.searchHits = undefined;
        }
    }

    private handle(text: string, address: string): void {
        for (const line of text.split(/\r\n?|\n/)) {
            const reply = parseReply(line.trim());
            if (reply?.cls !== 2) {
                continue;
            }
            if (reply.command === 'ACKN') {
                this.searchHits?.set(address, { address, mac: reply.value.toLowerCase() });
            } else if (['LKUP', 'ERST', 'POWR', 'INPT'].includes(reply.command)) {
                this.onNotification({ address, command: reply.command, value: reply.value });
            }
        }
    }
}
