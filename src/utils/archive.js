import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { fromPath, tempPath } from './media-file.js';

async function fileCrc(file) {
  let value = 0;
  for await (const chunk of fs.createReadStream(file)) value = crc32(chunk, value);
  return value;
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function pathSafeName(filename) {
  return (
    String(filename || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 240) || 'file'
  );
}

function zipEntryName(filename, index, names) {
  const original = pathSafeName(filename);
  const extension = original.includes('.') ? original.slice(original.lastIndexOf('.')) : '';
  const stem = extension ? original.slice(0, -extension.length) : original;
  let name = original;
  let suffix = 1;
  while (names.has(name)) {
    const marker = `-${suffix++}`;
    name = `${stem.slice(0, 240 - marker.length - extension.length)}${marker}${extension}`;
  }
  names.add(name);
  return name || `file-${index + 1}`;
}

// Stored (uncompressed) zip of media files, written straight to a temp file.
export async function writeZip(files, filename = 'archive.zip') {
  const out = await tempPath('.zip');
  const handle = await fsp.open(out, 'wx', 0o600);
  const central = [];
  const names = new Set();
  let offset = 0;
  try {
    for (const [index, file] of files.entries()) {
      const name = Buffer.from(zipEntryName(file.filename, index, names));
      const checksum = await fileCrc(file.path);
      const header = Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(file.size),
        u32(file.size),
        u16(name.length),
        u16(0),
        name,
      ]);
      await handle.write(header);
      for await (const chunk of fs.createReadStream(file.path)) await handle.write(chunk);
      central.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(checksum),
          u32(file.size),
          u32(file.size),
          u16(name.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
          name,
        ])
      );
      offset += header.length + file.size;
    }
    const centralBuffer = Buffer.concat(central);
    await handle.write(centralBuffer);
    await handle.write(
      Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(centralBuffer.length),
        u32(offset),
        u16(0),
      ])
    );
  } finally {
    await handle.close();
  }
  return fromPath(out, { archive: true, contentType: 'application/zip', filename });
}
