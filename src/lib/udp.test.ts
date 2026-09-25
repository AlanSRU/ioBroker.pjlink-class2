import { expect } from 'chai';
import { createSocket } from 'node:dgram';
import { PjlinkUdp, type Notification } from './udp';

/** A free UDP port on localhost. */
async function freePort(): Promise<number> {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    const { port } = socket.address();
    await new Promise<void>(resolve => socket.close(resolve));
    return port;
}

/**
 * Send one datagram to localhost.
 *
 * @param port - destination port
 * @param text - datagram payload
 */
async function send(port: number, text: string): Promise<void> {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.send(text, port, '127.0.0.1', () => resolve()));
    socket.close();
}

describe('PjlinkUdp', () => {
    let udp: PjlinkUdp | undefined;

    afterEach(() => udp?.close());

    it('delivers status notifications', async () => {
        const port = await freePort();
        const received: Notification[] = [];
        udp = new PjlinkUdp(n => received.push(n), port);
        await udp.open('127.0.0.1');

        await send(port, '%2POWR=3\r');
        await send(port, '%2ERST=000010\r%2INPT=3A\r');
        await send(port, '%2LKUP=00:11:22:AA:BB:CC\r');
        await send(port, '%1POWR=1\r'); // Class 1 lines are not notifications
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(received.map(n => `${n.command}=${n.value}`)).to.deep.equal([
            'POWR=3',
            'ERST=000010',
            'INPT=3A',
            'LKUP=00:11:22:AA:BB:CC',
        ]);
        expect(received[0].address).to.equal('127.0.0.1');
    });

    it('collects search answers and ignores its own search request', async () => {
        const port = await freePort();
        const received: Notification[] = [];
        udp = new PjlinkUdp(n => received.push(n), port);
        await udp.open('127.0.0.1');

        const search = udp.search(['127.0.0.1'], 200, ms => new Promise(resolve => setTimeout(resolve, ms)));
        await send(port, '%2ACKN=00:11:22:AA:BB:CC\r');
        const hits = await search;
        expect(hits).to.deep.equal([{ address: '127.0.0.1', mac: '00:11:22:aa:bb:cc' }]);
        expect(received).to.deep.equal([]);
    });

    it('fails to open a port that is already taken', async () => {
        const port = await freePort();
        udp = new PjlinkUdp(() => undefined, port);
        await udp.open('127.0.0.1');
        const second = new PjlinkUdp(() => undefined, port);
        await second.open('127.0.0.1').should.be.rejectedWith(/EADDRINUSE/);
    });
});
