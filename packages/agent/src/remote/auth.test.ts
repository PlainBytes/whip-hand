import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FailureThrottle, checkHostAndOrigin, generateToken, localAddresses, parseAuthority, tokenFromProtocolHeader,
  tokenMatches,
} from './auth.ts';

const PORT = 61338;
const ALLOWED = ['localhost', '127.0.0.1', '::1', '192.168.1.20'];

test('generateToken yields distinct 256-bit base64url strings', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test('tokenMatches accepts only the exact token', () => {
  const token = generateToken();
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, `${token}x`), false, 'longer');
  assert.equal(tokenMatches(token, token.slice(0, -1)), false, 'shorter');
  assert.equal(tokenMatches(token, `${token.slice(0, -1)}!`), false, 'same length, wrong value');
  assert.equal(tokenMatches(token, null), false);
  assert.equal(tokenMatches(token, undefined), false);
  assert.equal(tokenMatches(token, ''), false);
});

test('tokenFromProtocolHeader pulls the token out of the offered list', () => {
  assert.equal(tokenFromProtocolHeader(undefined), null);
  assert.equal(tokenFromProtocolHeader('other-protocol'), null);
  assert.equal(tokenFromProtocolHeader('whiphand.token.abc123'), 'abc123');
  assert.equal(tokenFromProtocolHeader('other-protocol, whiphand.token.abc123'), 'abc123');
  // Node folds repeated headers into an array; ws itself only ever hands
  // this function a single string, but the parser tolerates either.
  assert.equal(tokenFromProtocolHeader(['other-protocol', 'whiphand.token.abc123']), 'abc123');
});

test('parseAuthority table', () => {
  const cases: Array<[string | undefined, ReturnType<typeof parseAuthority>]> = [
    ['192.168.1.20:61338', { host: '192.168.1.20', port: 61338 }],
    ['LOCALHOST:61338', { host: 'localhost', port: 61338 }],
    ['localhost', { host: 'localhost', port: null }],
    ['[::1]:61338', { host: '::1', port: 61338 }],
    ['[::1]', { host: '::1', port: null }],
    ['::1', { host: '::1', port: null }],
    ['[::1', null],
    ['[::1]x61338', null],
    ['host:notaport', null],
    ['host:0', null],
    ['host:70000', null],
    [':61338', null],
    ['', null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseAuthority(input), expected, `parseAuthority(${JSON.stringify(input)})`);
  }
});

test('checkHostAndOrigin: Host must name an address we bind, on the port we listen on', () => {
  const ok = (headers: Record<string, string>) =>
    checkHostAndOrigin(headers, PORT, ALLOWED).ok;

  assert.equal(ok({ host: '192.168.1.20:61338' }), true, 'LAN address, right port');
  assert.equal(ok({ host: 'localhost:61338' }), true, 'loopback name');
  assert.equal(ok({ host: '[::1]:61338' }), true, 'IPv6 loopback');

  // The rebinding case: the attacker's hostname resolves to our IP, but the
  // browser still sends the name it was asked for.
  assert.equal(ok({ host: 'evil.example:61338' }), false, 'DNS rebinding');
  assert.equal(ok({ host: '192.168.1.20:1234' }), false, 'wrong port');
  assert.equal(ok({ host: '192.168.1.20' }), false, 'no port means port 80, which we are not');
  assert.equal(ok({ host: '10.0.0.9:61338' }), false, 'an address this machine does not have');
  assert.equal(ok({}), false, 'missing Host');
  assert.equal(ok({ host: '' }), false, 'empty Host');
});

test('checkHostAndOrigin: Origin, when present, must match the served origin', () => {
  const check = (origin: unknown) =>
    checkHostAndOrigin(
      { host: '192.168.1.20:61338', ...(origin === undefined ? {} : { origin }) } as never,
      PORT, ALLOWED,
    );

  assert.equal(check(undefined).ok, true, 'absent Origin: only non-browsers can do this');
  assert.equal(check('http://192.168.1.20:61338').ok, true);
  assert.equal(check('HTTP://192.168.1.20:61338').ok, true, 'case-insensitive');

  assert.equal(check('null').ok, false, 'sandboxed iframe / redirect');
  assert.equal(check('http://evil.example').ok, false);
  assert.equal(check('http://192.168.1.20:1234').ok, false, 'right host, wrong port');
  assert.equal(check('https://192.168.1.20:61338').ok, false, 'we do not serve https');
  assert.equal(check(['http://192.168.1.20:61338']).ok, false, 'malformed (array) Origin');
});

test('checkHostAndOrigin: an IPv6 Host builds a bracketed expected Origin', () => {
  const result = checkHostAndOrigin(
    { host: '[::1]:61338', origin: 'http://[::1]:61338' }, PORT, ALLOWED,
  );
  assert.equal(result.ok, true);
});

test('checkHostAndOrigin failures carry a reason worth logging', () => {
  const result = checkHostAndOrigin({ host: 'evil.example:61338' }, PORT, ALLOWED);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /evil\.example/);
});

test('localAddresses always includes loopback', () => {
  const addrs = localAddresses();
  for (const loopback of ['localhost', '127.0.0.1', '::1']) {
    assert.ok(addrs.includes(loopback), `expected ${loopback}`);
  }
});

test('FailureThrottle blocks after max failures and expires', () => {
  const throttle = new FailureThrottle(3, 1_000);
  let now = 0;

  assert.equal(throttle.blocked('1.2.3.4', now), false);
  for (let i = 0; i < 3; i++) throttle.record('1.2.3.4', now);
  assert.equal(throttle.blocked('1.2.3.4', now), true);
  assert.equal(throttle.blocked('5.6.7.8', now), false, 'per-IP, not global');

  now += 1_001;
  assert.equal(throttle.blocked('1.2.3.4', now), false, 'window expired');

  for (let i = 0; i < 3; i++) throttle.record('1.2.3.4', now);
  assert.equal(throttle.blocked('1.2.3.4', now), true);
  throttle.clear('1.2.3.4');
  assert.equal(throttle.blocked('1.2.3.4', now), false, 'a success clears the counter');
});
