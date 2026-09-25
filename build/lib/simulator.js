"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var simulator_exports = {};
__export(simulator_exports, {
  PjlinkSimulator: () => PjlinkSimulator
});
module.exports = __toCommonJS(simulator_exports);
var import_node_dgram = require("node:dgram");
var import_node_net = require("node:net");
var import_pjlink = require("./pjlink");
class PjlinkSimulator {
  state = {
    power: 0,
    input: "31",
    inputs: ["11", "12", "31", "32"],
    inputNames: { 11: "Computer 1", 12: "Computer 2", 31: "HDMI 1", 32: "HDMI 2" },
    videoMute: false,
    audioMute: false,
    freeze: false,
    errors: "000000",
    lamps: "1163 0",
    name: "Simulated projector",
    manufacturer: "SIM",
    model: "PJ-2000",
    other: "simulator",
    serial: "SN123456",
    software: "1.0.0",
    inputResolution: "1920x1080",
    recommendedResolution: "1920x1200",
    filterHours: 250,
    lampModel: "LMP-1",
    filterModel: "FLT-1",
    volume: 10,
    microphone: 5
  };
  /** every command line received, without the auth digest */
  received = [];
  cls;
  password;
  unsupported;
  ignored;
  digest;
  /** number of TCP connections accepted */
  connections = 0;
  server;
  sockets = /* @__PURE__ */ new Set();
  /** @param options - simulator options */
  constructor(options = {}) {
    var _a, _b, _c, _d, _e;
    this.cls = (_a = options.cls) != null ? _a : 2;
    this.password = (_b = options.password) != null ? _b : "";
    this.unsupported = new Set((_c = options.unsupported) != null ? _c : []);
    this.ignored = new Set((_d = options.ignored) != null ? _d : []);
    this.digest = (_e = options.digest) != null ? _e : "md5";
  }
  /**
   * Start listening; resolves with the port.
   *
   * @param port - TCP port, 0 for any free port
   */
  listen(port = 0) {
    return new Promise((resolve) => {
      this.server = (0, import_node_net.createServer)((socket) => this.accept(socket));
      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }
  /** Stop listening and drop every connection. */
  close() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    return new Promise((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
  /**
   * Send a Class 2 status notification, like a real projector would.
   *
   * @param port - the controller's UDP port
   * @param line - e.g. "%2POWR=1"
   */
  notify(port, line) {
    const socket = (0, import_node_dgram.createSocket)("udp4");
    return new Promise((resolve) => socket.send(`${line}\r`, port, "127.0.0.1", () => socket.close(() => resolve())));
  }
  accept(socket) {
    this.sockets.add(socket);
    this.connections++;
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => void 0);
    const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    let authenticated = !this.password;
    socket.write(this.password ? `PJLINK 1 ${random}\r` : "PJLINK 0\r");
    let buffer = "";
    socket.on("data", (chunk) => {
      var _a;
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r");
      buffer = (_a = lines.pop()) != null ? _a : "";
      for (let line of lines) {
        if (!authenticated) {
          const digest = (0, import_pjlink.authDigest)(random, this.password, this.digest);
          if (line.slice(0, digest.length) !== digest) {
            socket.end("PJLINK ERRA\r");
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
  answer(line) {
    const m = /^%([12])([A-Z0-9]{4}) ?(.*)$/.exec(line);
    if (!m) {
      return "%1ERR1";
    }
    const [, clsText, cmd, param] = m;
    const cls = Number(clsText);
    const head = `%${cls}${cmd}=`;
    if (cls > this.cls || this.unsupported.has(cmd)) {
      return `${head}ERR1`;
    }
    const s = this.state;
    const query = param === "?";
    const on = s.power === 1;
    switch (cmd) {
      case "POWR":
        if (query) {
          return `${head}${s.power}`;
        }
        if (param !== "0" && param !== "1") {
          return `${head}ERR2`;
        }
        if (s.power === 2 || s.power === 3) {
          return `${head}ERR3`;
        }
        s.power = param === "1" ? 1 : 0;
        return `${head}OK`;
      case "INPT":
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
      case "AVMT": {
        if (query) {
          if (s.videoMute && s.audioMute) {
            return `${head}31`;
          }
          return `${head}${s.videoMute ? "11" : s.audioMute ? "21" : "30"}`;
        }
        const mm = /^([123])([01])$/.exec(param);
        if (!mm) {
          return `${head}ERR2`;
        }
        if (mm[1] !== "2") {
          s.videoMute = mm[2] === "1";
        }
        if (mm[1] !== "1") {
          s.audioMute = mm[2] === "1";
        }
        return `${head}OK`;
      }
      case "FREZ":
        if (query) {
          return `${head}${s.freeze ? 1 : 0}`;
        }
        s.freeze = param === "1";
        return `${head}OK`;
      case "SVOL":
      case "MVOL": {
        const key = cmd === "SVOL" ? "volume" : "microphone";
        if (param !== "0" && param !== "1") {
          return `${head}ERR2`;
        }
        s[key] += param === "1" ? 1 : -1;
        return `${head}OK`;
      }
      case "INNM": {
        const code = param.replace(/^\?/, "");
        return s.inputNames[code] ? `${head}${s.inputNames[code]}` : `${head}ERR2`;
      }
    }
    if (!query) {
      return `${head}ERR2`;
    }
    const values = {
      ERST: s.errors,
      LAMP: s.lamps,
      INST: s.inputs.join(" "),
      NAME: s.name,
      INF1: s.manufacturer,
      INF2: s.model,
      INFO: s.other,
      CLSS: String(this.cls),
      SNUM: s.serial,
      SVER: s.software,
      IRES: on ? s.inputResolution : "-",
      RRES: s.recommendedResolution,
      FILT: String(s.filterHours),
      RLMP: s.lampModel,
      RFIL: s.filterModel
    };
    return cmd in values ? `${head}${values[cmd]}` : `${head}ERR1`;
  }
}
if (require.main === module) {
  const [port = "4352", cls = "2", password = ""] = process.argv.slice(2);
  const sim = new PjlinkSimulator({ cls: cls === "1" ? 1 : 2, password });
  void sim.listen(Number(port)).then((p) => {
    console.log(`PJLink Class ${sim.cls} simulator on 127.0.0.1:${p}${password ? " (password set)" : ""}`);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PjlinkSimulator
});
//# sourceMappingURL=simulator.js.map
