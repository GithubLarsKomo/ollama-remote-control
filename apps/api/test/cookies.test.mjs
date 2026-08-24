import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, sessionCookie } from '../dist/cookies.js';

test('cookies are Secure by default', () => {
  const previous = process.env.ORC_SECURE_COOKIES;
  delete process.env.ORC_SECURE_COOKIES;
  try {
    assert.match(sessionCookie('session-token', 60), /; Secure;/u);
    assert.match(csrfCookie('csrf-token', 60), /; Secure;/u);
  } finally {
    if (previous === undefined) delete process.env.ORC_SECURE_COOKIES;
    else process.env.ORC_SECURE_COOKIES = previous;
  }
});

test('ORC_SECURE_COOKIES=false permits explicit HTTP beta sessions', () => {
  const previous = process.env.ORC_SECURE_COOKIES;
  process.env.ORC_SECURE_COOKIES = 'false';
  try {
    const session = sessionCookie('session-token', 60);
    const csrf = csrfCookie('csrf-token', 60);
    assert.doesNotMatch(session, /; Secure(?:;|$)/u);
    assert.doesNotMatch(csrf, /; Secure(?:;|$)/u);
    assert.match(session, /SameSite=Strict/u);
    assert.match(session, /HttpOnly/u);
  } finally {
    if (previous === undefined) delete process.env.ORC_SECURE_COOKIES;
    else process.env.ORC_SECURE_COOKIES = previous;
  }
});
