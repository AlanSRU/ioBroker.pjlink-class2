import { expect } from 'chai';
import { createServer } from 'node:net';
import {
    PjlinkClient,
    PjlinkError,
    ReplyTimeoutError,
    authDigest,
    inputLabel,
    isInputCode,
    parseAvMute,
    parseErrorStatus,
    parseInputList,
    parseLamps,
    parseReply,
} from './pjlink';
import { PjlinkSimulator } from '../../test/lib/simulator';

describe('PJLink parsers', () => {
    it('computes the authentication digest (PJLink specification example)', () => {
        // spec example: random "498e4a67", password "JBMIAProjectorLink"
        expect(authDigest('498e4a67', 'JBMIAProjectorLink')).to.equal('5d8409bc1c3fa39749434aa3a5c38682');
    });

    it('parses replies', () => {
        expect(parseReply('%1POWR=1')).to.deep.equal({ cls: 1, command: 'POWR', value: '1' });
        expect(parseReply('%2ACKN=00:11:22:33:44:55')).to.deep.equal({
            cls: 2,
            command: 'ACKN',
            value: '00:11:22:33:44:55',
        });
        expect(parseReply('%1NAME=')).to.deep.equal({ cls: 1, command: 'NAME', value: '' });
        expect(parseReply('PJLINK 0')).to.equal(undefined);
    });

    it('parses the error status', () => {
        expect(parseErrorStatus('000210')).to.deep.equal({
            fan: 0,
            lamp: 0,
            temperature: 0,
            coverOpen: 2,
            filter: 1,
            other: 0,
        });
        expect(parseErrorStatus('0003')).to.equal(undefined);
    });

    it('parses lamps', () => {
        expect(parseLamps('1163 1')).to.deep.equal([{ hours: 1163, on: true }]);
        expect(parseLamps('10 0 20 1')).to.deep.equal([
            { hours: 10, on: false },
            { hours: 20, on: true },
        ]);
        expect(parseLamps('abc')).to.deep.equal([]);
    });

    it('parses AV mute', () => {
        expect(parseAvMute('11')).to.deep.equal({ video: true, audio: false });
        expect(parseAvMute('21')).to.deep.equal({ video: false, audio: true });
        expect(parseAvMute('31')).to.deep.equal({ video: true, audio: true });
        expect(parseAvMute('30')).to.deep.equal({ video: false, audio: false });
        expect(parseAvMute('41')).to.equal(undefined);
    });

    it('parses input lists and codes', () => {
        expect(parseInputList('11 12 31 3a 61')).to.deep.equal(['11', '12', '31', '3A', '61']);
        expect(isInputCode('31')).to.equal(true);
        expect(isInputCode('3Z')).to.equal(true);
        expect(isInputCode('71')).to.equal(false);
        expect(isInputCode('30')).to.equal(false);
        expect(inputLabel('31')).to.equal('Digital 1');
    });
});

describe('PjlinkClient', () => {
    let sim: PjlinkSimulator;

    afterEach(() => sim?.close());

    it('talks to a projector without authentication', async () => {
        sim = new PjlinkSimulator({ cls: 1 });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port });
        expect(await client.send(1, 'CLSS', '?')).to.equal('1');
        expect(await client.send(1, 'POWR', '1')).to.equal('OK');
        expect(await client.send(1, 'POWR', '?')).to.equal('1');
    });

    it('runs several commands in one session', async () => {
        sim = new PjlinkSimulator();
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port });
        const values = await client.session(async s => [
            await s.send(1, 'NAME', '?'),
            await s.send(1, 'LAMP', '?'),
            await s.send(2, 'SNUM', '?'),
        ]);
        expect(values).to.deep.equal(['Simulated projector', '1163 0', 'SN123456']);
    });

    it('authenticates, sending the digest with the first command only', async () => {
        sim = new PjlinkSimulator({ password: 'secret' });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port, password: 'secret' });
        const values = await client.session(async s => [await s.send(1, 'POWR', '?'), await s.send(1, 'CLSS', '?')]);
        expect(values).to.deep.equal(['0', '2']);
        expect(sim.received).to.deep.equal(['%1POWR ?', '%1CLSS ?']);
    });

    it('falls back to a sha256 digest and remembers it', async () => {
        sim = new PjlinkSimulator({ password: 'secret', digest: 'sha256' });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port, password: 'secret' });
        expect(await client.send(1, 'POWR', '?')).to.equal('0');
        expect(client.digestAlgorithm).to.equal('sha256');
        expect(sim.connections).to.equal(2); // md5 refused, then sha256
        expect(await client.send(1, 'CLSS', '?')).to.equal('2');
        expect(sim.connections).to.equal(3); // no md5 attempt any more
    });

    it('rejects a wrong password with ERRA', async () => {
        sim = new PjlinkSimulator({ password: 'secret' });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port, password: 'wrong' });
        const error = await client.send(1, 'POWR', '?').catch(e => e);
        expect(error).to.be.instanceOf(PjlinkError);
        expect((error as PjlinkError).code).to.equal('ERRA');
    });

    it('refuses to connect without a password when one is required', async () => {
        sim = new PjlinkSimulator({ password: 'secret' });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port });
        await client.send(1, 'POWR', '?').should.be.rejectedWith(/requires a PJLink password/);
    });

    it('reports ERR replies as PjlinkError', async () => {
        sim = new PjlinkSimulator({ cls: 1 });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port });
        const unsupported = await client.send(2, 'FREZ', '?').catch(e => e);
        expect((unsupported as PjlinkError).code).to.equal('ERR1');
        sim.state.power = 2; // cooling: power commands are refused
        const busy = await client.send(1, 'POWR', '1').catch(e => e);
        expect((busy as PjlinkError).code).to.equal('ERR3');
        expect((busy as Error).message).to.contain('unavailable time');
    });

    it('carries on after a command the projector ignores', async () => {
        sim = new PjlinkSimulator({ cls: 1, ignored: ['SNUM'] });
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port, timeoutMs: 200 });
        const values = await client.session(async s => [
            await s.send(2, 'SNUM', '?').catch(e => e),
            await s.send(1, 'POWR', '?'),
        ]);
        expect(values[0]).to.be.instanceOf(ReplyTimeoutError);
        expect(values[1]).to.equal('0');
    });

    it('serialises sessions', async () => {
        sim = new PjlinkSimulator();
        const port = await sim.listen();
        const client = new PjlinkClient({ host: '127.0.0.1', port });
        await Promise.all([
            client.send(1, 'POWR', '1'),
            client.send(1, 'POWR', '?'),
            client.send(1, 'AVMT', '11'),
            client.send(1, 'AVMT', '?'),
        ]);
        expect(sim.received).to.deep.equal(['%1POWR 1', '%1POWR ?', '%1AVMT 11', '%1AVMT ?']);
    });

    it('rejects when nothing listens', async () => {
        const server = createServer();
        const port = await new Promise<number>(resolve =>
            server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
        );
        await new Promise(resolve => server.close(resolve));
        const client = new PjlinkClient({ host: '127.0.0.1', port, timeoutMs: 1000 });
        await client.send(1, 'POWR', '?').should.be.rejectedWith(/ECONNREFUSED/);
    });

    it('times out when the device never greets', async () => {
        const server = createServer(() => undefined);
        const port = await new Promise<number>(resolve =>
            server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
        );
        try {
            const client = new PjlinkClient({ host: '127.0.0.1', port, timeoutMs: 200 });
            await client.send(1, 'POWR', '?').should.be.rejectedWith(/no reply within 200 ms/);
        } finally {
            server.close();
        }
    });

    it('rejects a device that is not PJLink', async () => {
        const server = createServer(socket => socket.end('SSH-2.0-OpenSSH\r\n'));
        const port = await new Promise<number>(resolve =>
            server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
        );
        try {
            const client = new PjlinkClient({ host: '127.0.0.1', port });
            await client.send(1, 'POWR', '?').should.be.rejectedWith(/not a PJLink device/);
        } finally {
            server.close();
        }
    });
});
