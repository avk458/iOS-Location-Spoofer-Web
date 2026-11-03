const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const a = require('../public/location-spoofer.js');
const source = fs.readFileSync(require.resolve('../public/location-spoofer.js'), 'utf8');
const cfg = { latitude: 30.123, longitude: -110.456, horizontalAccuracy: 39 };
const cat = a.concatBytes;
const v = a.makeVarintField;
const l = a.makeLengthDelimitedField;
const location = cat([v(1, 100000000), v(2, 200000000), v(3, 100), v(5, 55)]);
const payload = cat([l(2, l(2, location)), l(22, l(5, location)), v(33, 17)]);
const body = a.buildSyntheticResponse(payload);
function run(input = body, remote = cfg, extra = {}) {
  const done = [], logs = [];
  const headers = { 'CONTENT-ENCODING': 'gzip', 'content-length': '1', 'Content-Type': 'application/octet-stream' };
  vm.runInNewContext(source, {
    Uint8Array, ArrayBuffer,
    $request: { url: 'https://gs-loc.apple.com/clls/wloc' },
    $response: { status: 200, headers, body: input },
    $argument: 'configUrl=https://example.test/loc.json&debug=true',
    $httpClient: { get: (_, cb) => cb(null, { status: remote ? 200 : 500 }, JSON.stringify(remote)) },
    $done: x => done.push(x), console: { log: s => logs.push(s) }, ...extra
  });
  assert.equal(done.length, 1);
  return { result: done[0], logs, headers };
}
test('rewrites both coordinate types and preserves unrelated fields', () => {
  const r = a.spoofAppleResponse(body, cfg);
  assert.equal(r.wifiCount, 1); assert.equal(r.cellCount, 1);
  const fields = a.parseFields(a.extractEnvelope(r.response).payload);
  for (const entity of fields.slice(0, 2)) {
    const loc = a.parseFields(a.parseFields(entity.valueBytes)[0].valueBytes);
    assert.equal(loc[0].int64Value, a.coordToInt(cfg.latitude));
    assert.equal(loc[1].int64Value, a.coordToInt(cfg.longitude));
    assert.equal(loc[3].int64Value, 55);
  }
  assert.equal(fields[2].int64Value, 17);
});
test('242 cell entities without coordinates are not reported as patched', () => {
  const input = a.buildSyntheticResponse(cat(Array.from({length:242}, () => l(22, v(1,123)))));
  const r = a.spoofAppleResponse(input, cfg);
  assert.equal(r.cellCount, 0); assert.deepEqual(r.response, input);
  assert.equal(Object.keys(run(input).result).length, 0);
});
test('preserves synthetic suffix and bare protobuf format', () => {
  const suffix = new Uint8Array([99,88,77]);
  const r = a.spoofAppleResponse(cat([body,suffix]), cfg);
  assert.deepEqual(r.response.slice(-3), suffix);
  assert.equal(a.extractEnvelope(a.spoofAppleResponse(payload,cfg).response).kind, 'bare');
});
test('response hook returns binary body at top level without mutating input headers', () => {
  const {result,headers,logs} = run();
  assert.ok(result.body instanceof Uint8Array);
  assert.equal(result.response, undefined);
  assert.equal(result.status, undefined);
  assert.equal(result.headers['CONTENT-ENCODING'], undefined);
  assert.equal(result.headers['content-length'], undefined);
  assert.equal(result.headers['Content-Length'], String(result.body.length));
  assert.equal(headers['CONTENT-ENCODING'], 'gzip');
  assert.ok(logs.some(s => s.includes('bytesChanged=true')));
  assert.ok(logs.some(s => s.includes('Config source: remote')));
});
test('remote failure or invalid coordinates pass through instead of using Beijing defaults', () => {
  for (const remote of [null, {}, {latitude:999,longitude:0}]) {
    assert.equal(Object.keys(run(body,remote).result).length, 0);
  }
});
test('malformed response fails open; request hook does not fabricate response', () => {
  assert.equal(Object.keys(run(new Uint8Array([255,255,255])).result).length,0);
  assert.equal(Object.keys(run(body,cfg,{$response:undefined}).result).length,0);
});
test('deployed and root script copies stay identical', () => {
  assert.equal(source, fs.readFileSync(require.resolve('../location-spoofer.js'),'utf8'));
});
