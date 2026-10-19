import {Supply, decode, MAX_POINTS, intervalFor, csvHeader, csvRow} from './protocol.mjs';

const $ = id => document.getElementById(id);
const fields = [
  {key:'voltage', label:'Voltage', unit:'V', color:'#8be3b3'},
  {key:'current', label:'Current', unit:'A', color:'#73bdf5'},
  {key:'output', label:'Output', unit:'0 / 1', color:'#dfb673'},
  {key:'temperature', label:'Temperature', unit:'°C', color:'#d69cda'}
];
let db, supply, running = false, busy = false, exporting = false, samples = [], count = 0, horizon = 15, lastTime = 0;
let clearTimer, clearing = false, logVersion = 0;
const canvas = $('plot'), ctx = canvas.getContext('2d');
const duration = () => horizon * 60000;
const interval = () => intervalFor(horizon);
const message = text => { $('message').textContent = text; };
const status = (text, live = false) => { $('status').textContent = text; $('status').classList.toggle('live', live); };

function transaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('samples', mode);
    let result;
    const request = action(tx.objectStore('samples'));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || Error('Log storage failed.'));
    tx.onerror = () => reject(tx.error);
  });
}

function controls() {
  $('connect').textContent = running ? 'Disconnect' : 'Connect';
  $('connect').disabled = busy || !db || !navigator.serial;
  $('address').disabled = running || busy;
  $('clear').disabled = !db || clearing;
  $('save').disabled = !count || busy || exporting;
  $('count').textContent = `${count.toLocaleString()} samples saved`;
  $('rate').textContent = `${(interval() / 1000).toFixed(2).replace(/0$/, '')} s / sample`;
}

function draw() {
  const {width, height} = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const selected = fields.filter(f => document.querySelector(`[data-field="${f.key}"]`).checked);
  ctx.font = '11px system-ui';
  if (!selected.length || !samples.length) {
    ctx.fillStyle = '#8da392'; ctx.textAlign = 'center';
    ctx.fillText(selected.length ? 'Connect to start logging' : 'Select a measurement to plot', width / 2, height / 2);
    return;
  }
  const end = running ? Date.now() : lastTime, start = end - duration();
  const visible = samples.filter(row => row.time >= start);
  const left = width < 600 ? 66 : 86, right = width - 22, bottom = height - 38;
  const lane = (bottom - 18) / selected.length;
  selected.forEach((field, index) => {
    const top = 18 + index * lane + 20, base = 18 + (index + 1) * lane - 15;
    let low = Infinity, high = -Infinity;
    for (const row of visible) { low = Math.min(low, row[field.key]); high = Math.max(high, row[field.key]); }
    if (!visible.length) { low = 0; high = 1; }
    if (field.key === 'output') { low = -.1; high = 1.1; }
    else { const pad = Math.max((high - low) * .12, .01, Math.abs(high) * .015); low -= pad; high += pad; }
    const x = time => left + (time - start) / duration() * (right - left);
    const y = value => base - (value - low) / (high - low) * (base - top);
    ctx.textAlign = 'left'; ctx.fillStyle = field.color;
    ctx.fillText(`${field.label} (${field.unit})`, left, top - 8);
    for (let tick = 0; tick <= 2; tick++) {
      const value = field.key === 'output' ? tick / 2 : low + (high - low) * tick / 2;
      if (field.key === 'output' && tick === 1) continue;
      const py = y(value);
      ctx.strokeStyle = '#25372b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillStyle = '#8da392';
      ctx.fillText(field.key === 'output' ? value.toFixed(0) : value.toFixed(2), left - 10, py + 4);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top - 2, right - left, base - top + 4); ctx.clip();
    ctx.strokeStyle = field.color; ctx.lineWidth = 1.7; ctx.beginPath();
    let previous;
    for (const row of visible) {
      const px = x(row.time), py = y(row[field.key]);
      if (!previous || row.time - previous.time > Math.max(6000, interval() * 3)) ctx.moveTo(px, py);
      else { if (field.key === 'output') ctx.lineTo(px, y(previous[field.key])); ctx.lineTo(px, py); }
      previous = row;
    }
    ctx.stroke();
    if (visible.length === 1) { ctx.fillStyle = field.color; ctx.beginPath(); ctx.arc(x(visible[0].time), y(visible[0][field.key]), 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  });
  ctx.fillStyle = '#8da392';
  for (let i = 0; i <= 4; i++) {
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
    const time = new Date(start + duration() * i / 4);
    ctx.fillText(time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}), left + (right - left) * i / 4, height - 14);
  }
}

async function restore() {
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction('samples');
    const req = tx.objectStore('samples').openCursor(null, 'prev'), rows = [];
    req.onsuccess = () => { const cursor = req.result; if (cursor && rows.length < MAX_POINTS) { rows.push(cursor.value); cursor.continue(); } else resolve(rows.reverse()); };
    req.onerror = () => reject(req.error);
  });
  samples = rows; lastTime = samples.at(-1)?.time || 0;
  if (lastTime) showValues(samples.at(-1));
  count = await transaction('readonly', store => store.count());
}

function showValues(row) {
  for (const field of fields) {
    const digits = field.key === 'output' ? 0 : field.key === 'temperature' ? 1 : 3;
    $(field.key).replaceChildren(document.createTextNode(row[field.key].toFixed(digits)));
    const unit = document.createElement('small'); unit.textContent = field.unit; $(field.key).append(unit);
  }
}

async function log() {
  try {
    const [decimals] = await supply.read(0x0005, 1);
    while (running) {
      const started = performance.now();
      const state = await supply.read(0x0001, 3);
      const values = await supply.read(0x0010, 2);
      const row = decode(state, values, decimals);
      await transaction('readwrite', store => store.add(row));
      samples.push(row); if (samples.length > MAX_POINTS) samples.shift();
      lastTime = row.time; count++; showValues(row); controls(); draw();
      await new Promise(resolve => setTimeout(resolve, Math.max(8, interval() - (performance.now() - started))));
    }
  } catch (error) { message(error.message); }
  finally {
    running = false; busy = true; controls();
    try { await supply.close(); } catch (error) { message(error.message); }
    supply = null; busy = false; status('Disconnected'); controls(); draw();
  }
}

$('connect').onclick = async () => {
  if (running) { running = false; busy = true; controls(); status('Disconnecting…'); return; }
  if (!$('address').reportValidity()) return;
  busy = true; message(''); controls();
  try {
    const port = await navigator.serial.requestPort({filters:[{usbVendorId:0x1a86}]});
    supply = new Supply(port, Number($('address').value)); await supply.open();
    running = true; busy = false; status('Logging', true); controls(); void log();
  } catch (error) {
    if (supply) { try { await supply.close(); } catch {} supply = null; }
    busy = false; if (error.name !== 'NotFoundError') message(error.message); controls();
  }
};

function setHorizon(value) {
  horizon = Math.max(1, Math.min(120, Math.round(Number(value) || 15)));
  $('horizon').value = $('range').value = horizon; controls(); draw();
}
$('horizon').onchange = event => setHorizon(event.target.value);
$('range').oninput = event => setHorizon(event.target.value);
document.querySelectorAll('[data-field]').forEach(input => { input.onchange = draw; });
new ResizeObserver(draw).observe(canvas);

$('clear').onclick = async () => {
  if (!clearTimer) {
    $('clear').textContent = 'Click again to clear';
    clearTimer = setTimeout(() => { clearTimer = null; $('clear').textContent = 'Clear log'; }, 5000);
    return;
  }
  clearTimeout(clearTimer); clearTimer = null; clearing = true; logVersion++;
  $('clear').textContent = 'Clear log'; controls();
  try { await transaction('readwrite', store => store.clear()); count = 0; samples = []; lastTime = 0; message(''); draw(); }
  catch (error) { message(error.message); }
  finally { clearing = false; controls(); }
};

$('save').onclick = async () => {
  let stream;
  const version = logVersion;
  exporting = true; controls();
  try {
    const file = await window.showSaveFilePicker({suggestedName:`powersupply-${new Date().toISOString().replaceAll(':', '-')}.csv`, types:[{description:'CSV', accept:{'text/csv':['.csv']}}]});
    stream = await file.createWritable();
    const last = await new Promise((resolve, reject) => {
      const req = db.transaction('samples').objectStore('samples').openKeyCursor(null, 'prev');
      req.onsuccess = () => resolve(req.result?.key || 0); req.onerror = () => reject(req.error);
    });
    if (version !== logVersion) throw Error('CSV canceled: log cleared.');
    await stream.write(csvHeader);
    let key = 0;
    while (key < last) {
      const rows = await transaction('readonly', store => store.getAll(IDBKeyRange.bound(key, last, true, false), 1000));
      if (version !== logVersion) throw Error('CSV canceled: log cleared.');
      if (!rows.length) break;
      await stream.write(rows.map(csvRow).join('')); key = rows.at(-1).id;
    }
    if (version !== logVersion) throw Error('CSV canceled: log cleared.');
    await stream.close(); stream = null; message('CSV saved.');
  } catch (error) { if (stream) await stream.abort(); if (error.name !== 'AbortError') message(error.message); }
  finally { exporting = false; controls(); }
};

try {
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('powersupply', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('samples', {keyPath:'id', autoIncrement:true});
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  await restore(); status('Disconnected');
  if (!navigator.serial || !window.showSaveFilePicker) message('Open in desktop Chrome or Edge for USB serial and CSV export.');
  controls(); draw();
} catch (error) { status('Storage unavailable'); message(error.message); }
