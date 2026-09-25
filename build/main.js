"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_promises = require("node:dns/promises");
var import_node_net = require("node:net");
var utils = __toESM(require("@iobroker/adapter-core"));
var import_pjlink = require("./lib/pjlink");
var import_udp = require("./lib/udp");
const RESERVED_IDS = ["info"];
const POWER_CONFIRM_MS = 3e4;
const OFFLINE_AFTER = 2;
const STABLE_POLLS = 10;
const SILENT_LIMIT = 3;
const SEARCH_WAIT_MS = 1e4;
const POWER_STATES = { 0: "Off", 1: "On", 2: "Cooling", 3: "Warming" };
const FAULT_STATES = { 0: "OK", 1: "Warning", 2: "Error" };
const FAULTS = [
  ["fan", "Fan"],
  ["lamp", "Lamp"],
  ["temperature", "Temperature"],
  ["coverOpen", "Cover open"],
  ["filter", "Filter"],
  ["other", "Other"]
];
class PjlinkClass2 extends utils.Adapter {
  projectors = /* @__PURE__ */ new Map();
  /** ids of disabled projectors, whose objects are kept */
  disabledIds = /* @__PURE__ */ new Set();
  udp;
  /** status poll interval in ms */
  pollInterval = 5e3;
  /** set first thing in onUnload, so a still-running onReady stops before opening resources */
  stopped = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "pjlink-class2"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    await this.buildProjectors();
    await this.removeStaleObjects();
    for (const p of this.projectors.values()) {
      await this.createBaseObjects(p);
    }
    for (const id of this.disabledIds) {
      if (await this.getObjectAsync(`${id}.info.connection`)) {
        await this.setState(`${id}.info.connection`, { val: false, ack: true });
      }
    }
    if (this.stopped) {
      return;
    }
    this.subscribeStates("*");
    if (this.config.notifications) {
      const udp = new import_udp.PjlinkUdp((n) => void this.onNotification(n));
      try {
        await udp.open();
        if (this.stopped) {
          udp.close();
          return;
        }
        this.udp = udp;
        this.log.info("Listening for PJLink Class 2 notifications and search replies on UDP 4352");
      } catch (error) {
        this.log.warn(
          `Cannot listen on UDP 4352 (${error.message}); Class 2 notifications and search are disabled, polling continues. Is another PJLink controller or instance running on this host?`
        );
      }
    }
    if (!this.projectors.size) {
      this.log.warn("No projectors configured \u2014 open the instance settings and add at least one.");
      return;
    }
    this.pollInterval = Math.min(3600, Math.max(1, Number(this.config.pollInterval) || 5)) * 1e3;
    let stagger = 0;
    for (const p of this.projectors.values()) {
      this.schedulePoll(p, stagger);
      stagger += 250;
    }
  }
  /** Turn the configured projector table into runtime projectors. */
  async buildProjectors() {
    var _a;
    const devices = (_a = this.config.devices) != null ? _a : [];
    for (const device of devices) {
      const host = (device.host || "").trim();
      if (!host) {
        this.log.warn(`Ignoring projector "${device.name || "(unnamed)"}": no host configured.`);
        continue;
      }
      const label = (device.name || "").trim() || host;
      const id = this.makeId(label);
      if (device.enabled === false) {
        this.disabledIds.add(id);
        continue;
      }
      const port = Number(device.port) || 4352;
      let address = host;
      if (!(0, import_node_net.isIP)(host)) {
        address = await (0, import_promises.lookup)(host, { family: 4 }).then(
          (r) => r.address,
          () => host
        );
      }
      this.projectors.set(id, {
        id,
        label,
        host,
        address,
        client: new import_pjlink.PjlinkClient({ host, port, password: this.config.password }),
        cls: 0,
        unsupported: /* @__PURE__ */ new Set(),
        silent: /* @__PURE__ */ new Map(),
        failures: 0,
        successes: 0,
        inputs: [],
        lampCount: 0,
        connected: false,
        polling: false,
        refreshPending: false,
        nextInfo: 0
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
  makeId(label) {
    const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "projector";
    let id = RESERVED_IDS.includes(base) ? `${base}_projector` : base;
    for (let suffix = 2; this.projectors.has(id) || this.disabledIds.has(id); suffix++) {
      id = `${base}_${suffix}`;
    }
    return id;
  }
  /** Delete device folders of projectors that are no longer configured. */
  async removeStaleObjects() {
    for (const obj of await this.getDevicesAsync()) {
      const id = obj._id.substring(this.namespace.length + 1);
      if (!id.includes(".") && !this.projectors.has(id) && !this.disabledIds.has(id)) {
        this.log.info(`Removing objects of projector "${id}", which is no longer configured.`);
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }
  async createChannelObject(id, name) {
    await this.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
  }
  /**
   * Create a state. Strings default to '' and booleans to false. Number states get no default
   * on purpose: 0 would read as a real value (power Off, error status OK, 0 lamp hours) for a
   * projector that has not answered yet.
   *
   * @param id - state id
   * @param common - common part of the object
   */
  async createStateObject(id, common) {
    const def = common.type === "string" ? "" : common.type === "boolean" ? false : void 0;
    await this.setObjectNotExistsAsync(id, {
      type: "state",
      common: {
        read: true,
        write: false,
        ...def === void 0 ? {} : { def },
        ...common
      },
      native: {}
    });
  }
  /**
   * Create the Class 1 object tree of one projector.
   *
   * @param p - the projector
   */
  async createBaseObjects(p) {
    await this.extendObject(p.id, { type: "device", common: { name: p.label }, native: {} });
    await this.createChannelObject(`${p.id}.info`, "Information");
    await this.createChannelObject(`${p.id}.control`, "Control");
    await this.createChannelObject(`${p.id}.status`, "Status");
    await this.createChannelObject(`${p.id}.status.errors`, "Error status");
    const i = `${p.id}.info`;
    await this.createStateObject(`${i}.connection`, {
      name: "Projector connected",
      type: "boolean",
      role: "indicator.connected",
      def: false
    });
    await this.createStateObject(`${i}.class`, { name: "PJLink class", type: "number", role: "value" });
    await this.createStateObject(`${i}.name`, { name: "Projector name (NAME)", type: "string", role: "info.name" });
    await this.createStateObject(`${i}.manufacturer`, {
      name: "Manufacturer (INF1)",
      type: "string",
      role: "text"
    });
    await this.createStateObject(`${i}.model`, { name: "Product name (INF2)", type: "string", role: "info.model" });
    await this.createStateObject(`${i}.other`, { name: "Other information (INFO)", type: "string", role: "text" });
    await this.createStateObject(`${i}.inputs`, {
      name: "Available inputs (code -> name)",
      type: "string",
      role: "json"
    });
    await this.createStateObject(`${i}.lastError`, {
      name: "Last command error",
      type: "string",
      role: "text",
      def: ""
    });
    const c = `${p.id}.control`;
    await this.createStateObject(`${c}.power`, {
      name: "Power",
      type: "boolean",
      role: "switch.power",
      write: true,
      def: false
    });
    await this.createStateObject(`${c}.input`, { name: "Input", type: "string", role: "media.input", write: true });
    await this.createStateObject(`${c}.videoMute`, {
      name: "Video mute",
      type: "boolean",
      role: "switch",
      write: true
    });
    await this.createStateObject(`${c}.audioMute`, {
      name: "Audio mute",
      type: "boolean",
      role: "media.mute",
      write: true
    });
    await this.createStateObject(`${p.id}.status.power`, {
      name: "Power status",
      type: "number",
      role: "value",
      states: POWER_STATES
    });
    for (const [key, name] of FAULTS) {
      await this.createStateObject(`${p.id}.status.errors.${key}`, {
        name,
        type: "number",
        role: "value",
        states: FAULT_STATES
      });
    }
  }
  /**
   * Create the Class 2 additions, once the projector has reported Class 2.
   *
   * @param p - the projector
   */
  async createClass2Objects(p) {
    const i = `${p.id}.info`;
    await this.createStateObject(`${i}.serialNumber`, {
      name: "Serial number (SNUM)",
      type: "string",
      role: "info.serial"
    });
    await this.createStateObject(`${i}.softwareVersion`, {
      name: "Software version (SVER)",
      type: "string",
      role: "info.firmware"
    });
    await this.createStateObject(`${i}.macAddress`, { name: "MAC address", type: "string", role: "info.mac" });
    await this.createStateObject(`${i}.lampModel`, {
      name: "Replacement lamp model (RLMP)",
      type: "string",
      role: "text"
    });
    await this.createStateObject(`${i}.filterModel`, {
      name: "Replacement filter model (RFIL)",
      type: "string",
      role: "text"
    });
    await this.createStateObject(`${i}.recommendedResolution`, {
      name: "Recommended resolution (RRES)",
      type: "string",
      role: "text"
    });
    const c = `${p.id}.control`;
    await this.createStateObject(`${c}.freeze`, { name: "Freeze", type: "boolean", role: "switch", write: true });
    for (const [key, name, role] of [
      ["volumeUp", "Speaker volume up", "button.volume.up"],
      ["volumeDown", "Speaker volume down", "button.volume.down"],
      ["microphoneUp", "Microphone volume up", "button"],
      ["microphoneDown", "Microphone volume down", "button"]
    ]) {
      await this.createStateObject(`${c}.${key}`, { name, type: "boolean", role, read: false, write: true });
    }
    await this.createStateObject(`${p.id}.status.inputResolution`, {
      name: "Input signal resolution (IRES)",
      type: "string",
      role: "text"
    });
    await this.createStateObject(`${p.id}.status.filterHours`, {
      name: "Filter usage time (FILT)",
      type: "number",
      role: "value",
      unit: "h"
    });
  }
  /**
   * Create lamp states for lamps the projector has just reported.
   *
   * @param p - the projector
   * @param count - number of lamps reported
   */
  async createLampObjects(p, count) {
    await this.createChannelObject(`${p.id}.status.lamps`, "Lamps");
    for (let n = p.lampCount + 1; n <= count; n++) {
      await this.createChannelObject(`${p.id}.status.lamps.${n}`, `Lamp ${n}`);
      await this.createStateObject(`${p.id}.status.lamps.${n}.hours`, {
        name: `Lamp ${n} hours`,
        type: "number",
        role: "value",
        unit: "h"
      });
      await this.createStateObject(`${p.id}.status.lamps.${n}.on`, {
        name: `Lamp ${n} on`,
        type: "boolean",
        role: "indicator"
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
  async query(p, s, cls, command, param = "?") {
    var _a;
    const key = `${cls}${command}${param}`;
    if (p.unsupported.has(key)) {
      return void 0;
    }
    try {
      const value = await s.send(cls, command, param);
      p.silent.delete(key);
      return value;
    } catch (error) {
      if (error instanceof import_pjlink.ReplyTimeoutError && cls === 2) {
        const count = ((_a = p.silent.get(key)) != null ? _a : 0) + 1;
        p.silent.set(key, count);
        if (count >= SILENT_LIMIT) {
          this.log.info(`[${p.label}] did not answer %2${command} ${count} times; not asking again`);
          p.unsupported.add(key);
        } else {
          this.log.debug(`[${p.label}] no answer to %2${command} (${count}/${SILENT_LIMIT})`);
        }
        return void 0;
      }
      if (!(error instanceof import_pjlink.PjlinkError) || error.code === "ERRA") {
        throw error;
      }
      if (error.code === "ERR1") {
        this.log.info(`[${p.label}] does not support ${command}; not asking again`);
        p.unsupported.add(key);
      } else {
        this.log.debug(`[${p.label}] ${error.message}`);
      }
      return void 0;
    }
  }
  /**
   * Poll one projector for its status and, when due, its information.
   *
   * @param p - the projector to poll
   */
  async poll(p) {
    if (p.polling) {
      p.refreshPending = true;
      return;
    }
    p.polling = true;
    const full = !p.connected || Date.now() >= p.nextInfo;
    const updates = [];
    try {
      await p.client.session(async (s) => {
        if (!p.cls) {
          const cls = await this.query(p, s, 1, "CLSS");
          if (cls !== void 0 || p.unsupported.has("1CLSS?")) {
            p.cls = cls === "2" ? 2 : 1;
            if (p.cls === 2) {
              await this.createClass2Objects(p);
            }
            updates.push(["info.class", p.cls]);
          }
        }
        const c2 = p.cls === 2;
        const inputClass = c2 ? 2 : 1;
        const power = await this.query(p, s, 1, "POWR");
        if (power !== void 0 && /^[0-3]$/.test(power)) {
          updates.push(...this.powerUpdates(p, Number(power)));
        }
        const input = await this.query(p, s, inputClass, "INPT");
        if (input !== void 0) {
          updates.push(["control.input", input.toUpperCase()]);
        }
        const avmt = await this.query(p, s, 1, "AVMT");
        const mute = avmt === void 0 ? void 0 : (0, import_pjlink.parseAvMute)(avmt);
        if (mute) {
          updates.push(["control.videoMute", mute.video], ["control.audioMute", mute.audio]);
        }
        const erst = await this.query(p, s, 1, "ERST");
        const errors = erst === void 0 ? void 0 : (0, import_pjlink.parseErrorStatus)(erst);
        if (errors) {
          updates.push(...this.errorUpdates(errors));
        }
        if (c2) {
          const freeze = await this.query(p, s, 2, "FREZ");
          if (freeze !== void 0) {
            updates.push(["control.freeze", freeze === "1"]);
          }
          const ires = await this.query(p, s, 2, "IRES");
          if (ires !== void 0) {
            updates.push(["status.inputResolution", ires]);
          }
        }
        if (full) {
          await this.pollInfo(p, s, updates);
        }
      });
      if (full) {
        p.nextInfo = Date.now() + Math.min(86400, Math.max(10, Number(this.config.infoInterval) || 300)) * 1e3;
      }
      for (const [id, val] of updates) {
        await this.setState(`${p.id}.${id}`, { val, ack: true });
      }
      p.failures = 0;
      if (++p.successes >= STABLE_POLLS) {
        p.lastPollError = void 0;
      }
      await this.setConnected(p, true);
    } catch (error) {
      p.successes = 0;
      const confirmed = ++p.failures >= OFFLINE_AFTER || !p.connected;
      const message = error.message;
      if (confirmed && message !== p.lastPollError) {
        this.log.warn(`[${p.label}] poll failed: ${message}`);
        p.lastPollError = message;
      } else {
        this.log.debug(`[${p.label}] poll failed: ${message}`);
      }
      if (confirmed) {
        await this.setConnected(p, false);
      }
    } finally {
      p.polling = false;
      this.schedulePoll(p, p.refreshPending ? 0 : this.pollInterval);
      p.refreshPending = false;
    }
  }
  /**
   * Replace the projector's pending poll with one after the given delay.
   *
   * @param p - the projector
   * @param delayMs - delay before polling
   */
  schedulePoll(p, delayMs) {
    if (this.stopped) {
      return;
    }
    if (p.pollTimer) {
      this.clearTimeout(p.pollTimer);
    }
    p.pollTimer = this.setTimeout(() => void this.poll(p), delayMs);
  }
  /**
   * The slow-changing part of a poll: identity, inputs, lamps and Class 2 details.
   *
   * @param p - the projector
   * @param s - the open session
   * @param updates - collects the state updates
   */
  async pollInfo(p, s, updates) {
    const c2 = p.cls === 2;
    for (const [command, id] of [
      ["NAME", "info.name"],
      ["INF1", "info.manufacturer"],
      ["INF2", "info.model"],
      ["INFO", "info.other"]
    ]) {
      const value = await this.query(p, s, 1, command);
      if (value !== void 0) {
        updates.push([id, value]);
      }
    }
    const inst = await this.query(p, s, c2 ? 2 : 1, "INST");
    if (inst !== void 0) {
      const inputs = (0, import_pjlink.parseInputList)(inst);
      const names = {};
      for (const code of inputs) {
        const name = c2 ? await this.query(p, s, 2, "INNM", `?${code}`) : void 0;
        names[code] = name ? `${name} (${(0, import_pjlink.inputLabel)(code)})` : (0, import_pjlink.inputLabel)(code);
      }
      if (inputs.join() !== p.inputs.join()) {
        p.inputs = inputs;
        await this.extendObject(`${p.id}.control.input`, { common: { states: names } });
      }
      updates.push(["info.inputs", JSON.stringify(names)]);
    }
    const lamp = await this.query(p, s, 1, "LAMP");
    if (lamp !== void 0) {
      const lamps = (0, import_pjlink.parseLamps)(lamp);
      if (lamps.length > p.lampCount) {
        await this.createLampObjects(p, lamps.length);
      }
      lamps.forEach((l, n) => {
        updates.push([`status.lamps.${n + 1}.hours`, l.hours], [`status.lamps.${n + 1}.on`, l.on]);
      });
    }
    if (c2) {
      for (const [command, id] of [
        ["SNUM", "info.serialNumber"],
        ["SVER", "info.softwareVersion"],
        ["RLMP", "info.lampModel"],
        ["RFIL", "info.filterModel"],
        ["RRES", "info.recommendedResolution"]
      ]) {
        const value = await this.query(p, s, 2, command);
        if (value !== void 0) {
          updates.push([id, value]);
        }
      }
      const filt = await this.query(p, s, 2, "FILT");
      if (filt !== void 0 && /^\d+$/.test(filt)) {
        updates.push(["status.filterHours", Number(filt)]);
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
  powerUpdates(p, status) {
    p.powerStatus = status;
    let on = status === import_pjlink.PowerStatus.ON || status === import_pjlink.PowerStatus.WARMING;
    const pending = p.pendingPower;
    if (pending) {
      if (status !== pending.fromStatus) {
        p.pendingPower = void 0;
      } else if (Date.now() < pending.until) {
        on = pending.on;
      } else {
        p.pendingPower = void 0;
        const message = `Power ${pending.on ? "on" : "off"} was accepted, but the projector has not changed state within ${POWER_CONFIRM_MS / 1e3} s \u2014 it may be refusing (e.g. a rest period after cooling down)`;
        this.log.warn(`[${p.label}] ${message}`);
        return [
          ["status.power", status],
          ["control.power", on],
          ["info.lastError", message]
        ];
      }
    }
    return [
      ["status.power", status],
      ["control.power", on]
    ];
  }
  errorUpdates(e) {
    return FAULTS.map(([key]) => [`status.errors.${key}`, e[key]]);
  }
  /**
   * Track the reachability of one projector; info.connection of the instance
   * reports whether any projector is answering.
   *
   * @param p - the projector
   * @param connected - whether it just answered
   */
  async setConnected(p, connected) {
    if (p.connected !== connected) {
      this.log.info(`[${p.label}] ${connected ? "connected" : "not reachable"}`);
    }
    p.connected = connected;
    await this.setState(`${p.id}.info.connection`, { val: connected, ack: true });
    const any = [...this.projectors.values()].some((x) => x.connected);
    await this.setState("info.connection", { val: any, ack: true });
  }
  /**
   * Apply a Class 2 status notification to the projector it came from.
   *
   * @param n - the notification
   */
  async onNotification(n) {
    const p = [...this.projectors.values()].find((x) => x.address === n.address);
    if (!p) {
      this.log.debug(`Ignoring ${n.command}=${n.value} from unconfigured ${n.address}`);
      return;
    }
    this.log.debug(`[${p.label}] notification ${n.command}=${n.value}`);
    let updates = [];
    switch (n.command) {
      case "POWR":
        if (/^[0-3]$/.test(n.value)) {
          updates = this.powerUpdates(p, Number(n.value));
        }
        break;
      case "INPT":
        if ((0, import_pjlink.isInputCode)(n.value)) {
          updates = [["control.input", n.value.toUpperCase()]];
        }
        break;
      case "ERST": {
        const errors = (0, import_pjlink.parseErrorStatus)(n.value);
        if (errors) {
          updates = this.errorUpdates(errors);
        }
        break;
      }
      case "LKUP":
        if (p.cls === 2 && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.value)) {
          updates = [["info.macAddress", n.value.toLowerCase()]];
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
  refreshSoon(p, delayMs) {
    if (p.polling) {
      p.refreshPending = true;
    } else {
      this.schedulePoll(p, delayMs);
    }
  }
  /**
   * Is called if a subscribed state changes.
   *
   * @param id - State ID
   * @param state - State object
   */
  async onStateChange(id, state) {
    var _a, _b;
    if (!state || state.ack) {
      return;
    }
    const rel = id.substring(`${this.namespace}.`.length);
    const separator = rel.indexOf(".");
    const p = separator > 0 ? this.projectors.get(rel.substring(0, separator)) : void 0;
    if (!p) {
      return;
    }
    const key = rel.substring(separator + 1);
    let request;
    switch (key) {
      case "control.power":
        request = [1, "POWR", state.val ? "1" : "0"];
        break;
      case "control.input": {
        const code = String((_a = state.val) != null ? _a : "").toUpperCase();
        if (!(0, import_pjlink.isInputCode)(code) || p.cls !== 2 && !/^[1-5][1-9]$/.test(code)) {
          const message = `"${code}" is not a valid PJLink Class ${p.cls || 1} input code`;
          this.log.warn(`[${p.label}] ${message}`);
          await this.setState(`${p.id}.info.lastError`, { val: message, ack: true });
          this.refreshSoon(p, 0);
          return;
        }
        request = [p.cls === 2 ? 2 : 1, "INPT", code];
        break;
      }
      case "control.videoMute":
        request = [1, "AVMT", state.val ? "11" : "10"];
        break;
      case "control.audioMute":
        request = [1, "AVMT", state.val ? "21" : "20"];
        break;
      case "control.freeze":
        request = [2, "FREZ", state.val ? "1" : "0"];
        break;
      case "control.volumeUp":
        request = [2, "SVOL", "1"];
        break;
      case "control.volumeDown":
        request = [2, "SVOL", "0"];
        break;
      case "control.microphoneUp":
        request = [2, "MVOL", "1"];
        break;
      case "control.microphoneDown":
        request = [2, "MVOL", "0"];
        break;
      default:
        this.log.warn(`Unhandled writable state: ${id}`);
        return;
    }
    try {
      await p.client.send(...request);
      const isOn = p.powerStatus === import_pjlink.PowerStatus.ON || p.powerStatus === import_pjlink.PowerStatus.WARMING;
      if (key === "control.power" && p.powerStatus !== void 0 && isOn !== Boolean(state.val)) {
        p.pendingPower = {
          on: Boolean(state.val),
          fromStatus: (_b = p.powerStatus) != null ? _b : -1,
          until: Date.now() + POWER_CONFIRM_MS
        };
      }
      await this.setState(id, { val: state.val, ack: true });
      await this.setState(`${p.id}.info.lastError`, { val: "", ack: true });
    } catch (error) {
      this.log.warn(`[${p.label}] ${key} failed: ${error.message}`);
      await this.setState(`${p.id}.info.lastError`, { val: error.message, ack: true });
    }
    this.refreshSoon(p, 500);
  }
  /**
   * Serve the "search" button of the admin UI.
   * Requires "common.messagebox": true in io-package.json.
   *
   * @param obj - the incoming message
   */
  async onMessage(obj) {
    if (typeof obj !== "object" || !obj.command) {
      return;
    }
    const reply = (response) => {
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, response, obj.callback);
      }
    };
    if (obj.command === "discover") {
      try {
        reply(await this.discover());
      } catch (error) {
        reply({ error: error.message });
      }
    } else {
      reply({ error: `unknown command "${obj.command}"` });
    }
  }
  /**
   * Broadcast a Class 2 search and merge the answers into the configured
   * projector table, which the admin UI then offers to save.
   */
  async discover() {
    var _a;
    if (!this.udp) {
      return { error: "search needs the UDP 4352 listener \u2014 enable notifications and check the log" };
    }
    const broadcast = (this.config.broadcastAddress || "255.255.255.255").split(/[\s,]+/).filter((a) => (0, import_node_net.isIP)(a) === 4);
    this.log.info(`Searching for PJLink Class 2 projectors via ${broadcast.join(", ")}...`);
    const hits = await this.udp.search(broadcast, SEARCH_WAIT_MS, (ms) => this.delay(ms));
    const devices = [...(_a = this.config.devices) != null ? _a : []];
    const known = /* @__PURE__ */ new Set();
    for (const d of devices) {
      const host = (d.host || "").trim();
      known.add(host);
      if (host && !(0, import_node_net.isIP)(host)) {
        await (0, import_promises.lookup)(host, { family: 4 }).then(
          (r) => known.add(r.address),
          () => void 0
        );
      }
    }
    for (const p of this.projectors.values()) {
      known.add(p.address);
    }
    let added = 0;
    for (const hit of hits) {
      if (known.has(hit.address)) {
        this.log.info(`Found ${hit.address} (${hit.mac}), already configured`);
        continue;
      }
      let name = "";
      try {
        const client = new import_pjlink.PjlinkClient({ host: hit.address, password: this.config.password });
        name = await client.send(1, "NAME", "?");
      } catch {
      }
      this.log.info(`Found ${hit.address} (${hit.mac})${name ? ` "${name}"` : ""}`);
      devices.push({ enabled: true, name, host: hit.address, port: 4352 });
      added++;
    }
    this.log.info(`Search finished: ${hits.length} projector(s) answered, ${added} added to the table.`);
    return {
      native: { ...this.config, devices },
      saveConfig: true,
      result: `${hits.length} projector(s) found, ${added} added`
    };
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    var _a;
    this.stopped = true;
    try {
      for (const p of this.projectors.values()) {
        if (p.pollTimer) {
          this.clearTimeout(p.pollTimer);
        }
        p.client.close();
      }
      (_a = this.udp) == null ? void 0 : _a.close();
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new PjlinkClass2(options);
} else {
  (() => new PjlinkClass2())();
}
//# sourceMappingURL=main.js.map
