// Core/chatVoice.test.js — v2.74.1591: the human-voice transforms every chat surface rides. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { friendlyError, actionPhrase, recordNounWord } from './chatVoice.js';

describe('chatVoice — friendlyError (slugs and codes → plain phrases; human text passes through)', () => {
  it('http codes get honest, specific phrasings', () => {
    assert.equal(friendlyError('http-401'), 'the site said you’re signed out (401)');
    assert.equal(friendlyError('http-404'), 'the site couldn’t find that page (404)');
    assert.equal(friendlyError('http-500'), 'the site had a server error (500)');
    assert.equal(friendlyError('429'), 'the site rate-limited us (429)');
    assert.equal(friendlyError('http-302'), 'the site answered 302');
  });
  it('known codes map; unknown internal slugs de-kebab to words', () => {
    assert.equal(friendlyError('no-content-script'), 'the page wasn’t reachable — refresh the site’s tab');
    assert.equal(friendlyError('session-expired'), 'the session looks signed out');
    assert.equal(friendlyError('vitals-dashboard-failed'), 'vitals dashboard failed');
    assert.equal(friendlyError('compose_empty'), 'compose empty');
  });
  it('human sentences pass through untouched; empty falls back', () => {
    assert.equal(friendlyError('The site rejected the request body.'), 'The site rejected the request body.');
    assert.equal(friendlyError(''), 'something went wrong');
    assert.equal(friendlyError(null, 'no reply'), 'no reply');
    assert.equal(friendlyError('Request timed out after 30s'), 'it timed out');
  });
});

describe('chatVoice — actionPhrase (catalog verbs read as sentences after "couldn’t")', () => {
  it('third-person heads go to base form; the rest of the phrase keeps', () => {
    assert.equal(actionPhrase('Returns the warranty task contacts'), 'return the warranty task contacts');
    assert.equal(actionPhrase('Finds a Shopify customer'), 'find a Shopify customer');
    assert.equal(actionPhrase('Searches orders by status'), 'search orders by status');
  });
  it('no generic s-stripping — unmapped heads only lowercase; acronyms keep; empty falls back', () => {
    assert.equal(actionPhrase('Status check for the queue'), 'status check for the queue');
    assert.equal(actionPhrase('GQL order lookup'), 'GQL order lookup');
    assert.equal(actionPhrase('', 'run that'), 'run that');
  });
});

describe('chatVoice — recordNounWord (a record gets a NOUN, never a verb phrase)', () => {
  it('strips the verb + article + qualifier tail; caps at a short noun', () => {
    assert.equal(recordNounWord('find a shopify customer by email'), 'shopify customer');
    assert.equal(recordNounWord('Warranty task details'), 'warranty task');
    assert.equal(recordNounWord('Returns the warranty task contacts'), 'warranty task contacts');
  });
  it('falls back rather than parroting something long or empty', () => {
    assert.equal(recordNounWord('runs the full cross-system correlation sweep for a case'), 'record');
    assert.equal(recordNounWord(''), 'record');
    assert.equal(recordNounWord(null, 'item'), 'item');
  });
});
