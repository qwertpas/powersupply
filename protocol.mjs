export const MAX_POINTS = 3600;
export const intervalFor = minutes => Math.max(250, minutes * 60000 / MAX_POINTS);

export function crc(bytes) {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xa001 : 0);
  }
  return value;
}

export function request(id, address, count) {
  const bytes = new Uint8Array([id, 3, address >> 8, address & 255, 0, count, 0, 0]);
  const check = crc(bytes.subarray(0, 6));
  bytes[6] = check & 255;
  bytes[7] = check >> 8;
  return bytes;
}

export function response(bytes, id, count) {
  const check = crc(bytes.subarray(0, -2));
  if (bytes[0] !== id || bytes.at(-2) !== (check & 255) || bytes.at(-1) !== (check >> 8)) throw Error('Invalid serial response or CRC.');
  if (bytes[1] === 0x83) throw Error(`Modbus exception ${bytes[2]}.`);
  if (bytes[1] !== 3 || bytes[2] !== count * 2 || bytes.length !== count * 2 + 5) throw Error('Unexpected serial response.');
  return Array.from({length: count}, (_, i) => bytes[3 + i * 2] * 256 + bytes[4 + i * 2]);
}

export class Supply {
  constructor(port, id) { this.port = port; this.id = id; }
  async open() {
    await this.port.open({baudRate:9600, dataBits:8, stopBits:1, parity:'none', flowControl:'none'});
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
  }
  async read(address, count) {
    await new Promise(resolve => setTimeout(resolve, 8));
    await this.writer.write(request(this.id, address, count));
    const bytes = [];
    let timer;
    try {
      return await Promise.race([
        (async () => {
          while (true) {
            const {value, done} = await this.reader.read();
            if (done) throw Error('Serial connection closed.');
            bytes.push(...value);
            const size = bytes[1] === 0x83 ? 5 : bytes.length >= 3 ? bytes[2] + 5 : Infinity;
            if (bytes.length >= size) return response(Uint8Array.from(bytes), this.id, count);
          }
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('No response. Check device ID and USB-C communication port.')), 1500); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async close() {
    try { if (this.reader) await this.reader.cancel(); }
    finally {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      if (this.port.readable || this.port.writable) await this.port.close();
    }
  }
}

export function decode(state, values, decimals) {
  return {time:Date.now(), voltage:values[0] / 10 ** (decimals >> 8 & 15),
    current:values[1] / 10 ** (decimals >> 4 & 15), output:state[0],
    temperature:(state[2] & 0x7fff) * (state[2] & 0x8000 ? -1 : 1)};
}
export const csvHeader = 'timestamp,voltage_V,current_A,output,temperature_C\r\n';
export const csvRow = row => `${new Date(row.time).toISOString()},${row.voltage},${row.current},${row.output},${row.temperature}\r\n`;
