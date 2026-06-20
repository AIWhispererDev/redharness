import { describe, it, expect } from 'vitest';
import { redactAttributes, redactDeep } from '../src/trace/redaction.js';

describe('Redaction', () => {
  describe('redactAttributes', () => {
    it('redacts authorization header', () => {
      const { attributes, redactions } = redactAttributes({
        'headers.authorization': 'Bearer secret-token-123',
        'headers.content-type': 'application/json',
      });

      expect(attributes['headers.authorization']).toBe('[REDACTED]');
      expect(attributes['headers.content-type']).toBe('application/json');
      expect(redactions.length).toBe(1);
      expect(redactions[0].ruleId).toBe('authorization-header');
    });

    it('redacts cookie headers', () => {
      const { attributes, redactions } = redactAttributes({
        'headers.cookie': 'session=abc123',
      });

      expect(attributes['headers.cookie']).toBe('[REDACTED]');
      expect(redactions[0].ruleId).toBe('cookie-header');
    });

    it('redacts API keys and tokens', () => {
      const { attributes } = redactAttributes({
        'api_key': 'sk-abc123',
        'auth_token': 'tok_xyz',
        'password': 'hunter2',
        'public_field': 'visible',
      });

      expect(attributes['api_key']).toBe('[REDACTED]');
      expect(attributes['auth_token']).toBe('[REDACTED]');
      expect(attributes['password']).toBe('[REDACTED]');
      expect(attributes['public_field']).toBe('visible');
    });

    it('redacts x-api-key header', () => {
      const { attributes, redactions } = redactAttributes({
        'headers.x-api-key': 'my-api-key-value',
      });

      expect(attributes['headers.x-api-key']).toBe('[REDACTED]');
      expect(redactions.some((r) => r.ruleId === 'x-api-key')).toBe(true);
    });

    it('does not redact values that fail the test predicate', () => {
      const { attributes, redactions } = redactAttributes({
        'headers.cookie': 123, // not a string — test predicate returns false
      });

      // The pattern matches but the test (typeof value === 'string') fails
      expect(redactions.length).toBe(0);
    });
  });

  describe('redactDeep', () => {
    it('redacts secrets in nested objects', () => {
      const input = {
        request: {
          headers: {
            authorization: 'Bearer top-secret',
          },
          body: { password: 'hunter2', comment: 'hello' },
        },
        response: { status: 200 },
      };

      const { result, redactions } = redactDeep(input) as any;

      expect(result.request.headers.authorization).toBe('[REDACTED]');
      expect(result.request.body.password).toBe('[REDACTED]');
      expect(result.request.body.comment).toBe('hello');
      expect(result.response.status).toBe(200);
      expect(redactions.length).toBeGreaterThanOrEqual(2);
    });

    it('handles arrays in nested objects', () => {
      const input = {
        items: [
          { token: 'abc', name: 'item1' },
          { token: 'def', name: 'item2' },
        ],
      };

      const { result } = redactDeep(input) as any;
      expect(result.items[0].token).toBe('[REDACTED]');
      expect(result.items[1].token).toBe('[REDACTED]');
      expect(result.items[0].name).toBe('item1');
    });

    it('handles primitive values', () => {
      expect(redactDeep('hello').result).toBe('hello');
      expect(redactDeep(42).result).toBe(42);
      expect(redactDeep(null).result).toBe(null);
      expect(redactDeep(true).result).toBe(true);
    });

    it('stores redaction entries with field paths', () => {
      const { redactions } = redactDeep({
        headers: {
          authorization: 'Bearer secret',
          'x-api-key': 'key-value',
        },
      });

      expect(redactions.length).toBeGreaterThanOrEqual(2);
      const authRedaction = redactions.find((r) => r.fieldPath.includes('authorization'));
      const keyRedaction = redactions.find((r) => r.fieldPath.includes('api-key'));
      expect(authRedaction).toBeTruthy();
      expect(keyRedaction).toBeTruthy();
    });
  });
});
