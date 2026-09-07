#!/usr/bin/env node
// Package foundry-module/ into the two artifacts Foundry's package registry
// wants: a `module.json` it can poll, and a `module.zip` it downloads.
//
//   node tools/build-module.mjs [version]
//
// The zip is written by hand rather than shelling out. `zip` is absent on
// Windows and `Compress-Archive` is absent everywhere else, so shelling out
// means two code paths and a class of bug that only shows up on the platform
// you do not develop on. A store-and-deflate writer is ~80 lines of zlib and
// works identically everywhere.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  MODULE_DIR,
  OUTPUT_DIR,
  collectModuleFiles,
  readManifest,
  verifyManifest,
} from "./lib/module.mjs";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** DOS timestamp. Fixed to a constant rather than "now" so the same input
 *  produces the same bytes — a reproducible artifact is one a user can verify
 *  against the source. */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

function localHeader(entry) {
  const name = Buffer.from(entry.name, "utf-8");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.compressed.length, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, "utf-8");
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.compressed.length, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE(0, 38); // external attrs
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

export function buildZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.absPath);
    const entry = {
      name: file.relPath,
      size: data.length,
      crc: crc32(data),
      compressed: zlib.deflateRawSync(data, { level: 9 }),
      offset,
    };
    const header = localHeader(entry);
    chunks.push(header, entry.compressed);
    offset += header.length + entry.compressed.length;
    entries.push(entry);
  }

  const central = entries.map(centralHeader);
  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

function main() {
  const requested = process.argv[2];
  const manifest = readManifest();

  if (requested && requested !== manifest.version) {
    console.error(
      `Refusing to build: you asked for ${requested} but module/module.json says ${manifest.version}.\n` +
        `Bump the manifest first — a zip whose version disagrees with its manifest installs and then never updates.`
    );
    process.exit(1);
  }

  const problems = verifyManifest(manifest);
  if (problems.length > 0) {
    console.error("Manifest problems:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const files = collectModuleFiles();
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const zip = buildZip(files);
  fs.writeFileSync(path.join(OUTPUT_DIR, "module.zip"), zip);
  // The registry polls the manifest at a stable URL and downloads the zip from
  // a versioned one, so both are release assets.
  fs.copyFileSync(path.join(MODULE_DIR, "module.json"), path.join(OUTPUT_DIR, "module.json"));

  console.log(`Built ${manifest.id} v${manifest.version}`);
  for (const file of files) console.log(`  + ${file.relPath}`);
  console.log(`\n${path.relative(process.cwd(), OUTPUT_DIR)}/module.zip  (${zip.length} bytes)`);
  console.log(`${path.relative(process.cwd(), OUTPUT_DIR)}/module.json`);
  console.log(`\nAttach BOTH to a GitHub release tagged foundry-v${manifest.version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
