import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request, response, decode, intervalFor, MAX_POINTS, csvHeader, csvRow, Supply, crc} from './protocol.mjs';

test('read request and captured device responses', () => {
  assert.equal(Buffer.from(request(1, 0x10, 1)).toString('hex'), '01030010000185cf');
  const state = response(Buffer.from('01030800010002001f00864cb3', 'hex'), 1, 4);
  const values = response(Buffer.from('0103080258005a0000021c956f', 'hex'), 1, 4);
  assert.deepEqual(state, [1, 2, 31, 134]);
  const row = decode(state, values, 0x0222);
  assert.equal(row.voltage, 6); assert.equal(row.current, .9);
  assert.equal(row.output, 1); assert.equal(row.temperature, 31);
  assert.equal(decode([0, 0, 0x800a], [1234, 560], 0x0232).current, .56);
  assert.equal(decode([0, 0, 0x800a], [1234, 560], 0x0232).temperature, -10);
});

test('CRC errors and Modbus exceptions stop acquisition', () => {
  assert.throws(() => response(Buffer.from('01030200000000', 'hex'), 1, 1), /CRC/);
  const bytes = Uint8Array.from([1, 0x83, 2, 0, 0]), check = crc(bytes.subarray(0, 3));
  bytes[3] = check & 255; bytes[4] = check >> 8;
  assert.throws(() => response(bytes, 1, 1), /exception 2/);
});

test('horizon bounds and CSV preserve all four measurements', () => {
  assert.equal(intervalFor(1), 250); assert.equal(intervalFor(120), 2000);
  assert.equal(120 * 60000 / intervalFor(120), MAX_POINTS);
  assert.equal(csvHeader + csvRow({time:0, voltage:6, current:.9, output:0, temperature:-10}),
    'timestamp,voltage_V,current_A,output,temperature_C\r\n1970-01-01T00:00:00.000Z,6,0.9,0,-10\r\n');
});

test('serial transport accepts fragmented frames and releases the port', async () => {
  let controller, closed = false;
  const port = {
    readable:new ReadableStream({start(c) { controller = c; }}),
    writable:new WritableStream({write() { const frame = Buffer.from('01030800010002001f00864cb3', 'hex'); controller.enqueue(frame.subarray(0, 2)); controller.enqueue(frame.subarray(2)); }}),
    async open(options) { assert.equal(options.baudRate, 9600); }, async close() { closed = true; }
  };
  const supply = new Supply(port, 1); await supply.open();
  assert.deepEqual(await supply.read(1, 4), [1, 2, 31, 134]);
  await supply.close(); assert.equal(closed, true);
  assert.equal(port.readable.locked, false); assert.equal(port.writable.locked, false);
});
