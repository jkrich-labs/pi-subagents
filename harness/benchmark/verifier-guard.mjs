// Loaded before candidate fixture code. Candidate modules must not replace
// assertion behavior or terminate/alter the verifier lifecycle.
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
Object.freeze(assert);
const denyExit = (name) => (code = 0) => {
  throw new Error(`verifier attempted process.${name}(${code})`);
};
for (const name of ["exit", "reallyExit", "abort"]) {
  if (typeof process[name] === "function") {
    Object.defineProperty(process, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: denyExit(name),
    });
  }
}
if (typeof process.kill === "function") {
  Object.defineProperty(process, "kill", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: denyExit("kill"),
  });
}
if (typeof process._kill === "function") {
  Object.defineProperty(process, "_kill", { configurable: false, enumerable: true, writable: false, value: denyExit("_kill") });
}
const denyNetwork = () => { throw new Error("verifier network access is not allowed"); };
for (const [module, names] of [[net, ["connect", "createConnection"]], [http, ["request", "get"]], [https, ["request", "get"]], [dns, ["lookup", "resolve", "resolve4", "resolve6"]], [dgram, ["createSocket"]], [tls, ["connect"]]]) {
  for (const name of names) if (typeof module[name] === "function") module[name] = denyNetwork;
}
syncBuiltinESMExports();
if (typeof globalThis.fetch === "function") globalThis.fetch = denyNetwork;
for (const name of ["on", "once", "addListener", "prependListener"]) {
  const original = process[name];
  if (typeof original !== "function") continue;
  Object.defineProperty(process, name, {
    configurable: false,
    enumerable: true,
    writable: false,
    value(event, listener) {
      if (event === "beforeExit" || event === "exit") throw new Error("verifier lifecycle hooks are not allowed");
      return original.call(this, event, listener);
    },
  });
}
for (const name of ["removeListener", "off", "removeAllListeners"]) {
  const original = process[name];
  if (typeof original !== "function") continue;
  Object.defineProperty(process, name, {
    configurable: false,
    enumerable: true,
    writable: false,
    value() {
      throw new Error("verifier lifecycle listener removal is not allowed");
    },
  });
}
if (process._events && typeof process._events === "object") Object.freeze(process._events);
// Remove EventEmitter inheritance so candidate code cannot recover the
// original listener methods through Object.getPrototypeOf(process).
Object.setPrototypeOf(process, null);
const protectAsync = (target, name) => {
  const original = target[name];
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    writable: false,
    value(callback, ...args) {
      return original.call(this, (...callbackArgs) => {
        const prior = process.exitCode;
        try {
          return callback(...callbackArgs);
        } finally {
          if (prior === 1) process.exitCode = 1;
        }
      }, ...args);
    },
  });
};
protectAsync(process, "nextTick");
protectAsync(globalThis, "queueMicrotask");
protectAsync(globalThis, "setImmediate");
protectAsync(globalThis, "setTimeout");
protectAsync(globalThis, "setInterval");
