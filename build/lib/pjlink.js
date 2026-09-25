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
var pjlink_exports = {};
__export(pjlink_exports, {
  INPUT_TYPES: () => INPUT_TYPES,
  PJLINK_PORT: () => PJLINK_PORT,
  PjlinkClient: () => PjlinkClient,
  PjlinkError: () => PjlinkError,
  PowerStatus: () => PowerStatus,
  ReplyTimeoutError: () => ReplyTimeoutError,
  authDigest: () => authDigest,
  inputLabel: () => inputLabel,
  isInputCode: () => isInputCode,
  parseAvMute: () => parseAvMute,
  parseErrorStatus: () => parseErrorStatus,
  parseInputList: () => parseInputList,
  parseLamps: () => parseLamps,
  parseReply: () => parseReply
});
module.exports = __toCommonJS(pjlink_exports);
var import_node_crypto = require("node:crypto");
var import_node_net = require("node:net");
const PJLINK_PORT = 4352;
const PowerStatus = {
  OFF: 0,
  ON: 1,
  COOLING: 2,
  WARMING: 3
};
const INPUT_TYPES = {
  1: "RGB",
  2: "Video",
  3: "Digital",
  4: "Storage",
  5: "Network",
  6: "Internal"
};
const ERROR_TEXT = {
  ERR1: "undefined command",
  ERR2: "out of parameter",
  ERR3: "unavailable time",
  ERR4: "projector/display failure",
  ERRA: "authentication failed"
};
class PjlinkError extends Error {
  /**
   * @param code - ERR1, ERR2, ERR3, ERR4 or ERRA
   * @param command - the command that failed, e.g. "POWR 1"
   */
  constructor(code, command) {
    var _a;
    super(`${command}: ${code} (${(_a = ERROR_TEXT[code]) != null ? _a : "unknown error"})`);
    this.code = code;
    this.command = command;
    this.name = "PjlinkError";
  }
}
class ReplyTimeoutError extends Error {
  /** @param timeoutMs - the timeout that expired */
  constructor(timeoutMs) {
    super(`no reply within ${timeoutMs} ms`);
    this.name = "ReplyTimeoutError";
  }
}
function authDigest(random, password, algorithm = "md5") {
  return (0, import_node_crypto.createHash)(algorithm).update(random + password, "utf8").digest("hex");
}
function parseReply(line) {
  const m = /^%([12])([A-Z0-9]{4})=(.*)$/i.exec(line);
  return m ? { cls: Number(m[1]), command: m[2].toUpperCase(), value: m[3] } : void 0;
}
function parseErrorStatus(value) {
  if (!/^[0-2]{6}$/.test(value)) {
    return void 0;
  }
  const d = [...value].map(Number);
  return { fan: d[0], lamp: d[1], temperature: d[2], coverOpen: d[3], filter: d[4], other: d[5] };
}
function parseLamps(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length % 2 || parts.some((p) => !/^\d+$/.test(p))) {
    return [];
  }
  const lamps = [];
  for (let i = 0; i < parts.length; i += 2) {
    lamps.push({ hours: Number(parts[i]), on: parts[i + 1] === "1" });
  }
  return lamps;
}
function parseAvMute(value) {
  const m = /^([123])([01])$/.exec(value);
  if (!m) {
    return void 0;
  }
  const on = m[2] === "1";
  return { video: on && m[1] !== "2", audio: on && m[1] !== "1" };
}
function parseInputList(value) {
  return value.trim().split(/\s+/).filter((code) => isInputCode(code)).map((code) => code.toUpperCase());
}
function isInputCode(code) {
  return /^[1-6][1-9A-Z]$/i.test(code);
}
function inputLabel(code) {
  var _a;
  return `${(_a = INPUT_TYPES[code[0]]) != null ? _a : "Input"} ${code[1]}`;
}
class PjlinkClient {
  host;
  port;
  password;
  timeoutMs;
  queue = Promise.resolve();
  active;
  algorithm = "md5";
  /** @param options - connection options */
  constructor(options) {
    var _a, _b;
    this.host = options.host;
    this.port = options.port || PJLINK_PORT;
    this.password = (_a = options.password) != null ? _a : "";
    this.timeoutMs = (_b = options.timeoutMs) != null ? _b : 5e3;
  }
  /**
   * Run a session: connect, handle the greeting, run the callback, close.
   * Sessions are serialised, so a poll and a command never overlap.
   *
   * @param fn - uses the session to send commands
   */
  session(fn) {
    const run = this.queue.then(() => this.authenticatedSession(fn));
    this.queue = run.catch(() => void 0);
    return run;
  }
  /**
   * Send one command in a session of its own.
   *
   * @param cls - 1 or 2
   * @param command - four-letter command
   * @param param - parameter, "?" for a query
   */
  send(cls, command, param) {
    return this.session((s) => s.send(cls, command, param));
  }
  /** The digest algorithm that authentication currently uses. */
  get digestAlgorithm() {
    return this.algorithm;
  }
  /** Abort the running session, if any. */
  close() {
    var _a;
    (_a = this.active) == null ? void 0 : _a.destroy();
  }
  async authenticatedSession(fn) {
    try {
      return await this.runSession(fn, this.algorithm);
    } catch (error) {
      if (!(error instanceof PjlinkError && error.code === "ERRA")) {
        throw error;
      }
      const other = this.algorithm === "md5" ? "sha256" : "md5";
      const result = await this.runSession(fn, other);
      this.algorithm = other;
      return result;
    }
  }
  async runSession(fn, algorithm) {
    var _a;
    const socket = new import_node_net.Socket();
    this.active = socket;
    const lines = new LineReader(socket, this.timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        const onTimeout = () => reject(new Error(`connection to ${this.host}:${this.port} timed out`));
        const done = () => {
          socket.off("timeout", onTimeout);
          socket.setTimeout(0);
        };
        socket.setTimeout(this.timeoutMs);
        socket.once("timeout", onTimeout);
        socket.once("connect", () => {
          done();
          resolve();
        });
        socket.once("error", (err) => {
          done();
          reject(err);
        });
        socket.connect(this.port, this.host);
      });
      const greeting = await lines.next();
      let prefix = "";
      const auth = /^PJLINK ([01])(?: (\S+))?$/i.exec(greeting);
      if (!auth) {
        throw new Error(
          /ERRA/i.test(greeting) ? "authentication failed" : `unexpected greeting "${greeting}" \u2014 not a PJLink device?`
        );
      }
      if (auth[1] === "1") {
        if (!this.password) {
          throw new Error("the projector requires a PJLink password, but none is configured");
        }
        prefix = authDigest((_a = auth[2]) != null ? _a : "", this.password, algorithm);
      }
      const session = {
        authenticated: auth[1] === "1",
        send: async (cls, command, param) => {
          const request = `%${cls}${command} ${param}`;
          socket.write(`${prefix}${request}\r`);
          prefix = "";
          for (; ; ) {
            const line = await lines.next();
            if (/^PJLINK ERRA$/i.test(line)) {
              throw new PjlinkError("ERRA", request);
            }
            const reply = parseReply(line);
            if ((reply == null ? void 0 : reply.command) !== command.toUpperCase()) {
              continue;
            }
            const code = reply.value.toUpperCase();
            if (code in ERROR_TEXT) {
              throw new PjlinkError(code, `${command} ${param}`);
            }
            return reply.value;
          }
        }
      };
      return await fn(session);
    } finally {
      lines.dispose();
      socket.destroy();
      if (this.active === socket) {
        this.active = void 0;
      }
    }
  }
}
class LineReader {
  /**
   * @param socket - socket to read from
   * @param timeoutMs - how long to wait for each line
   */
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    socket.on("timeout", this.onTimeout);
  }
  buffer = "";
  lines = [];
  waiter;
  failure;
  onData = (chunk) => {
    var _a;
    this.buffer += chunk.toString("utf8");
    const parts = this.buffer.split(/\r\n?|\n/);
    this.buffer = (_a = parts.pop()) != null ? _a : "";
    for (const part of parts) {
      if (part.trim()) {
        this.lines.push(part.trim());
      }
    }
    this.deliver();
  };
  onError = (err) => this.fail(err);
  onClose = () => this.fail(new Error("connection closed by the projector"));
  onTimeout = () => {
    const waiter = this.waiter;
    this.waiter = void 0;
    waiter == null ? void 0 : waiter.reject(new ReplyTimeoutError(this.timeoutMs));
  };
  /** Resolve with the next line. */
  next() {
    return new Promise((resolve, reject) => {
      const disarm = () => void this.socket.setTimeout(0);
      this.socket.setTimeout(this.timeoutMs);
      this.waiter = {
        resolve: (line) => {
          disarm();
          resolve(line);
        },
        reject: (err) => {
          disarm();
          reject(err);
        }
      };
      this.deliver();
    });
  }
  /** Stop listening. An error listener stays attached so a late error cannot go uncaught. */
  dispose() {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onError);
    this.socket.off("timeout", this.onTimeout);
    this.socket.on("error", () => void 0);
  }
  deliver() {
    if (!this.waiter) {
      return;
    }
    const waiter = this.waiter;
    if (this.lines.length) {
      this.waiter = void 0;
      waiter.resolve(this.lines.shift());
    } else if (this.failure) {
      this.waiter = void 0;
      waiter.reject(this.failure);
    }
  }
  fail(err) {
    var _a;
    (_a = this.failure) != null ? _a : this.failure = err;
    this.deliver();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  INPUT_TYPES,
  PJLINK_PORT,
  PjlinkClient,
  PjlinkError,
  PowerStatus,
  ReplyTimeoutError,
  authDigest,
  inputLabel,
  isInputCode,
  parseAvMute,
  parseErrorStatus,
  parseInputList,
  parseLamps,
  parseReply
});
//# sourceMappingURL=pjlink.js.map
