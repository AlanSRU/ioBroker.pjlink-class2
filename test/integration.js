const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

// the simulator is TypeScript and not part of the build
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '../tsconfig.json') });
const { PjlinkSimulator } = require('./lib/simulator');

const NS = 'pjlink-class2.0';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Polling a Class 1 projector every second', getHarness => {
            let harness;
            let sim;
            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const waitFor = async (id, predicate, timeoutMs = 8000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && predicate(state.val)) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                sim = new PjlinkSimulator({ cls: 1 });
                const port = await sim.listen();
                await harness.changeAdapterConfig('pjlink-class2', {
                    native: {
                        devices: [{ enabled: true, name: 'Sim 2', host: '127.0.0.1', port }],
                        pollInterval: 1,
                        infoInterval: 3600,
                        notifications: false,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(() => sim && sim.close());

            it('keeps polling: picks up repeated changes made outside the adapter', async function () {
                this.timeout(30000);
                expect(await waitFor('sim_2.info.class', v => v === 1)).to.equal(1);
                for (const power of [1, 0, 1]) {
                    sim.state.power = power;
                    expect(await waitFor('sim_2.status.power', v => v === power)).to.equal(power);
                }
            });
        });

        suite('Against a simulated Class 2 projector with a password', getHarness => {
            let harness;
            let sim;

            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const getObject = id =>
                new Promise((resolve, reject) =>
                    harness.objects.getObject(`${NS}.${id}`, (err, obj) => (err ? reject(err) : resolve(obj))),
                );
            const setState = (id, val) =>
                new Promise((resolve, reject) =>
                    harness.states.setState(`${NS}.${id}`, { val, ack: false }, err => (err ? reject(err) : resolve())),
                );
            /** Wait until a state has been acknowledged with the expected value. */
            const waitFor = async (id, predicate, timeoutMs = 8000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && predicate(state.val)) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                // RRES goes unanswered, as Class 2 commands do on an NEC NP3250
                sim = new PjlinkSimulator({ cls: 2, password: 'secret', ignored: ['RRES'] });
                const port = await sim.listen();
                await harness.changeAdapterConfig('pjlink-class2', {
                    native: {
                        devices: [{ enabled: true, name: 'Sim 1', host: '127.0.0.1', port }],
                        password: 'secret',
                        // effectively off: after the first poll, only commands and notifications refresh
                        pollInterval: 3600,
                        infoInterval: 3600,
                        notifications: true,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(() => sim && sim.close());

            it('reads the projector', async function () {
                this.timeout(30000);
                expect(await waitFor('sim_1.info.class', v => v === 2, 15000)).to.equal(2);
                expect(await waitFor('sim_1.info.model', v => v === 'PJ-2000')).to.equal('PJ-2000');
                expect(await waitFor('sim_1.info.serialNumber', v => !!v)).to.equal('SN123456');
                expect(await waitFor('sim_1.status.lamps.1.hours', v => v === 1163)).to.equal(1163);
                // FILT is asked after the ignored RRES
                expect(await waitFor('sim_1.status.filterHours', v => v === 250, 15000)).to.equal(250);
                // one unanswered poll is not enough to give up on it
                expect(harness.hasLog(/no answer to %2RRES \(1\/3\)/, 'debug')).to.equal(true);
                expect(await waitFor('sim_1.status.power', v => v === 0)).to.equal(0);
                const input = await getObject('sim_1.control.input');
                expect(input.common.states).to.include({ 31: 'HDMI 1 (Digital 1)' });
            });

            it('powers on', async () => {
                await setState('sim_1.control.power', true);
                await waitFor('sim_1.status.power', v => v === 1);
                expect(sim.state.power).to.equal(1);
                expect((await getState('sim_1.control.power')).val).to.equal(true);
            });

            it('switches input and mutes', async () => {
                await setState('sim_1.control.input', '32');
                await waitFor('sim_1.control.input', v => v === '32');
                expect(sim.state.input).to.equal('32');
                await setState('sim_1.control.videoMute', true);
                await waitFor('sim_1.control.videoMute', v => v === true);
                expect(sim.state.videoMute).to.equal(true);
                await setState('sim_1.control.freeze', true);
                await waitFor('sim_1.control.freeze', v => v === true);
                expect(sim.state.freeze).to.equal(true);
            });

            it('reports a refused command in info.lastError', async () => {
                sim.state.power = 2; // cooling
                await setState('sim_1.control.power', true);
                const error = await waitFor('sim_1.info.lastError', v => /ERR3/.test(v));
                expect(error).to.contain('unavailable time');
            });

            it('applies a Class 2 status notification', async () => {
                await sim.notify(4352, '%2ERST=000010');
                expect(await waitFor('sim_1.status.errors.filter', v => v === 1)).to.equal(1);
                expect(sim.state.errors).to.equal('000000'); // came from the notification, not a poll
            });
        });
    },
});
