/**
 * Fixture web application — v1 (correct/healthy behavior).
 *
 * Provides:
 * - Public landing page
 * - Auth-gated dashboard (fake auth via header)
 * - Form with validation
 * - API endpoints with predictable responses
 * - State snapshot for state-diff grading
 * - Health endpoint
 * - Reset endpoint
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface FixtureState {
  users: Record<string, { name: string; role: string }>;
  sessions: string[];
  formSubmissions: Array<{ name: string; email: string; timestamp: number }>;
  counter: number;
}

export function createFixtureState(): FixtureState {
  return {
    users: { 'user-1': { name: 'Alice', role: 'admin' }, 'user-2': { name: 'Bob', role: 'user' } },
    sessions: [],
    formSubmissions: [],
    counter: 0,
  };
}

let state = createFixtureState();

export function getState(): FixtureState {
  return { ...state, users: { ...state.users }, sessions: [...state.sessions], formSubmissions: [...state.formSubmissions] };
}

export function resetState(): void {
  state = createFixtureState();
}

function html(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fixture Web</title></head><body>${body}</body></html>`;
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function htmlResponse(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(html(body));
}

function isAuthenticated(req: IncomingMessage): boolean {
  return req.headers['x-auth-token'] === 'valid-token';
}

export function createFixtureApp(isV2Regression: boolean = false) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    // Health
    if (url.pathname === '/health') {
      jsonResponse(res, { status: 'ok', version: isV2Regression ? '2.0.0' : '1.0.0' });
      return;
    }

    // Reset
    if (url.pathname === '/reset') {
      resetState();
      jsonResponse(res, { status: 'reset' });
      return;
    }

    // State snapshot
    if (url.pathname === '/state') {
      jsonResponse(res, getState());
      return;
    }

    // Public landing
    if (url.pathname === '/') {
      htmlResponse(res, '<h1>Welcome to Fixture Web</h1><nav><a href="/dashboard">Dashboard</a> | <a href="/form">Form</a> | <a href="/api/health">API Health</a></nav>');
      return;
    }

    // About page
    if (url.pathname === '/about') {
      htmlResponse(res, '<h1>About Fixture Web</h1><p>This is a controlled test fixture version ' + (isV2Regression ? '2' : '1') + '.</p>');
      return;
    }

    // Dashboard (auth-gated)
    if (url.pathname === '/dashboard') {
      if (!isAuthenticated(req)) {
        if (isV2Regression) {
          // v2 regression: returns 403 instead of redirect
          htmlResponse(res, '<h1>Access Denied</h1><p>You do not have permission.</p>', 403);
        } else {
          htmlResponse(res, '<h1>Sign In Required</h1><p>Please sign in to access the dashboard.</p><a href="/">Go Home</a>', 401);
        }
        return;
      }
      htmlResponse(res, '<h1>Dashboard</h1><p>Welcome, authenticated user!</p><ul><li>Profile</li><li>Settings</li></ul>');
      return;
    }

    // Profile (auth-gated)
    if (url.pathname === '/profile') {
      if (!isAuthenticated(req)) {
        htmlResponse(res, '<h1>Unauthorized</h1>', 401);
        return;
      }
      jsonResponse(res, { name: 'Alice', role: 'admin', email: 'alice@example.com' });
      return;
    }

    // Form page
    if (url.pathname === '/form') {
      const formHtml = `
        <h1>Contact Form</h1>
        <form id="contact-form" method="POST" action="/submit">
          <label>Name: <input type="text" name="name" id="name" required></label><br>
          <label>Email: <input type="email" name="email" id="email" required></label><br>
          <button type="submit">Submit</button>
        </form>
        <div id="submissions"></div>
      `;
      htmlResponse(res, formHtml);
      return;
    }

    // API: list users
    if (url.pathname === '/api/users') {
      jsonResponse(res, Object.values(state.users));
      return;
    }

    // API: get user by ID
    if (url.pathname.startsWith('/api/users/')) {
      const userId = url.pathname.replace('/api/users/', '');
      const user = state.users[userId];
      if (!user) {
        jsonResponse(res, { error: 'User not found' }, 404);
        return;
      }
      jsonResponse(res, user);
      return;
    }

    // API: increment counter
    if (url.pathname === '/api/increment') {
      state.counter++;
      jsonResponse(res, { counter: state.counter });
      return;
    }

    // API: counter value (for state-diff testing)
    if (url.pathname === '/api/counter') {
      jsonResponse(res, { counter: state.counter });
      return;
    }

    // Form submission (POST)
    if (url.pathname === '/submit' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const name = params.get('name') || '';
        const email = params.get('email') || '';

        // v2 regression: remove client-side validation — accept empty fields
        if (!isV2Regression && (!name || !email)) {
          htmlResponse(res, '<h1>Validation Error</h1><p>Name and email are required.</p>', 400);
          return;
        }

        state.formSubmissions.push({ name, email, timestamp: Date.now() });
        htmlResponse(res, `<h1>Thank You</h1><p>Submitted: ${name} (${email})</p>`);
      });
      return;
    }

    // 404
    htmlResponse(res, '<h1>404 Not Found</h1><p>The requested page was not found.</p>', 404);
  });
}
