#!/usr/bin/env node
"use strict";

// This file is the npm/Docker entry point. Keep it dependency-free and parseable by old Node releases so
// users get an upgrade instruction instead of a SyntaxError from Hara's ESM output or its dependencies.
var MIN_NODE_MAJOR = 22;
var MIN_NODE_VERSION = "22.12.0";

function supportedNodeVersion(version) {
  var match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  var current = [Number(match[1]), Number(match[2]), Number(match[3])];
  var minimum = MIN_NODE_VERSION.split(".").map(Number);
  for (var index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function unsupportedNodeMessage(versions) {
  versions = versions || process.versions;
  if (versions.bun) return null;

  var version = String(versions.node || "unknown");
  if (supportedNodeVersion(version)) return null;
  var major = Number.parseInt(version, 10);
  var detail = major === MIN_NODE_MAJOR
    ? "This Node.js 22 release is below Hara's supported " + MIN_NODE_VERSION + " floor."
    : "This Node.js release is below Hara's supported " + MIN_NODE_VERSION + " floor.";
  return [
    "Hara requires Node.js " + MIN_NODE_VERSION + " or newer (detected " + version + ").",
    detail,
    "Upgrade with: nvm install " + MIN_NODE_MAJOR + " && nvm use " + MIN_NODE_MAJOR,
    "Or install the standalone Hara binary, which does not require Node.js:",
    "  curl -fsSL https://raw.githubusercontent.com/hara-cli/hara/main/install.sh | sh",
  ].join("\n");
}

function normalizePortableWindowsHome(value) {
  var home = String(value || "").trim();
  var drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(home);
  if (drive) return drive[1].toUpperCase() + ":\\" + String(drive[2] || "").replace(/\//g, "\\");
  if (/^\/\/[^/]/.test(home)) return "\\\\" + home.slice(2).replace(/\//g, "\\");
  if (/^[a-zA-Z]:[\\/]/.test(home)) return home.charAt(0).toUpperCase() + home.slice(1).replace(/\//g, "\\");
  return home;
}

function applyPortableHomeEnv(env, runtimePlatform) {
  env = env || process.env;
  runtimePlatform = runtimePlatform || process.platform;
  if (runtimePlatform !== "win32") return false;
  var home = normalizePortableWindowsHome(env.HOME || "");
  if (!home || env.USERPROFILE === home) return false;
  env.USERPROFILE = home;
  return true;
}

function failStart(error) {
  var message = error && error.message ? error.message : String(error);
  process.stderr.write("hara: failed to start: " + message + "\n");
  process.exitCode = 1;
}

function main() {
  var runtimeError = unsupportedNodeMessage(process.versions);
  if (runtimeError) {
    process.stderr.write(runtimeError + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    applyPortableHomeEnv(process.env, process.platform);
    // Keeping import() inside a string prevents legacy parsers from seeing unsupported ESM syntax. This
    // branch is reached only on the supported Node floor (or Bun when used as a script runtime).
    var load = Function("specifier", "return import(specifier)");
    var entry = require("url").pathToFileURL(require("path").join(__dirname, "dist", "index.js")).href;
    load(entry).catch(failStart);
  } catch (error) {
    failStart(error);
  }
}

module.exports = {
  MIN_NODE_MAJOR: MIN_NODE_MAJOR,
  MIN_NODE_VERSION: MIN_NODE_VERSION,
  supportedNodeVersion: supportedNodeVersion,
  unsupportedNodeMessage: unsupportedNodeMessage,
  applyPortableHomeEnv: applyPortableHomeEnv,
  normalizePortableWindowsHome: normalizePortableWindowsHome,
};

if (require.main === module) main();
