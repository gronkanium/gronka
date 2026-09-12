const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[i] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
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

export function createZip(files) {
  const local = [];
  const central = [];
  const names = new Set();
  let offset = 0;
  for (const [index, file] of files.entries()) {
    const name = Buffer.from(zipEntryName(file.filename, index, names));
    const checksum = crc32(file.buffer);
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(file.buffer.length),
      u32(file.buffer.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    local.push(header, file.buffer);
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
        u32(file.buffer.length),
        u32(file.buffer.length),
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
    offset += header.length + file.buffer.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBuffer.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...local, centralBuffer, end]);
}
