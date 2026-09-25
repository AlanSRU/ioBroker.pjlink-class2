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
var udp_exports = {};
__export(udp_exports, {
  PjlinkUdp: () => PjlinkUdp
});
module.exports = __toCommonJS(udp_exports);
var import_node_dgram = require("node:dgram");
var import_pjlink = require("./pjlink");
class PjlinkUdp {
  /**
   * @param onNotification - called for every status notification
   * @param port - UDP port to listen on (4352; tests use another)
   */
  constructor(onNotification, port = import_pjlink.PJLINK_PORT) {
    this.onNotification = onNotification;
    this.port = port;
  }
  socket;
  searchHits;
  /**
   * Bind the port.
   *
   * @param address - local address to bind, e.g. "0.0.0.0"
   */
  open(address = "0.0.0.0") {
    return new Promise((resolve, reject) => {
      const socket = (0, import_node_dgram.createSocket)({ type: "udp4", reuseAddr: false });
      socket.once("error", reject);
      socket.on("message", (msg, rinfo) => this.handle(msg.toString("utf8"), rinfo.address));
      socket.bind(this.port, address, () => {
        socket.off("error", reject);
        socket.on("error", () => void 0);
        socket.setBroadcast(true);
        this.socket = socket;
        resolve();
      });
    });
  }
  /** Close the port. */
  close() {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.close();
    this.socket = void 0;
  }
  /**
   * Broadcast a search and collect the answers.
   *
   * @param broadcast - broadcast addresses to send to
   * @param waitMs - how long to collect answers
   */
  async search(broadcast, waitMs) {
    const socket = this.socket;
    if (!socket) {
      throw new Error(`UDP port ${this.port} is not open, so search is unavailable`);
    }
    if (this.searchHits) {
      throw new Error("a search is already running");
    }
    this.searchHits = /* @__PURE__ */ new Map();
    try {
      for (const address of broadcast) {
        await new Promise(
          (resolve, reject) => socket.send("%2SRCH\r", this.port, address, (err) => err ? reject(err) : resolve())
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return [...this.searchHits.values()];
    } finally {
      this.searchHits = void 0;
    }
  }
  handle(text, address) {
    var _a;
    for (const line of text.split(/\r\n?|\n/)) {
      const reply = (0, import_pjlink.parseReply)(line.trim());
      if ((reply == null ? void 0 : reply.cls) !== 2) {
        continue;
      }
      if (reply.command === "ACKN") {
        (_a = this.searchHits) == null ? void 0 : _a.set(address, { address, mac: reply.value.toLowerCase() });
      } else if (["LKUP", "ERST", "POWR", "INPT"].includes(reply.command)) {
        this.onNotification({ address, command: reply.command, value: reply.value });
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PjlinkUdp
});
//# sourceMappingURL=udp.js.map
