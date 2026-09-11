// utils/fhir.js
// Auth-context factory for FHIR HTTP calls.
// Mirrors the same module in fhir-regulator-endpoint/utils/fhir.js.
//
// Usage (regular request handlers):
//   import { createFhirContext } from './utils/fhir.js';
//   const ctx = createFhirContext(req.session);
//   await axios.get(url, { headers: ctx.headers });
//
// Usage (webhook handler — no session):
//   import { getCachedFhirHeaders } from './utils/fhir.js';
//   await axios.get(url, { headers: getCachedFhirHeaders() });

import { getCredentials } from './credentialStore.js';

// Module-level cache — updated each time createFhirContext() is called.
// Provides headers to the webhook handler which has no req.session.
let _cachedAuthConfig = {
  type: 'none',
  apiKey: '',
  bearerToken: '',
  customHeaderName: '',
  customHeaderValue: ''
};

/**
 * Build FHIR HTTP headers from an auth config object.
 * Always includes Content-Type and Accept.
 */
function buildFhirHeaders(authConfig) {
  const headers = {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json'
  };

  if (!authConfig) return headers;

  switch (authConfig.type) {
    case 'apikey':
      if (authConfig.apiKey) {
        headers['Ocp-Apim-Subscription-Key'] = authConfig.apiKey;
      }
      break;
    case 'bearer':
      if (authConfig.bearerToken) {
        headers['Authorization'] = `Bearer ${authConfig.bearerToken}`;
      }
      break;
    case 'custom':
      if (authConfig.customHeaderName && authConfig.customHeaderValue) {
        headers[authConfig.customHeaderName] = authConfig.customHeaderValue;
      }
      break;
    // 'none' — no extra header
  }

  return headers;
}

/**
 * Create a FHIR context from an express-session object.
 * Also updates the module-level cache so the webhook handler can reuse
 * the same credentials without a session.
 *
 * @param {object} session - req.session (may be undefined / empty)
 * @returns {{ headers: object }}
 */
export function createFhirContext(session = {}) {
  // Fall back to process-level credential store when the session is empty
  // (new browser tab, session expired, server restart restored state).
  const stored = getCredentials();

  const authConfig = {
    type:              session.fhirAuthType         || stored.fhirAuthType         || 'none',
    apiKey:            session.fhirApiKey            || stored.fhirApiKey            || '',
    bearerToken:       session.fhirBearerToken       || stored.fhirBearerToken       || '',
    customHeaderName:  session.fhirCustomHeaderName  || stored.fhirCustomHeaderName  || '',
    customHeaderValue: session.fhirCustomHeaderValue || stored.fhirCustomHeaderValue || ''
  };

  // Cache so the webhook handler (no session) can use the last-seen config.
  // Only update when there is a meaningful auth type — avoids wiping the cache
  // when the FHIR server POSTs a webhook notification with no user session.
  if (authConfig.type !== 'none') {
    _cachedAuthConfig = { ...authConfig };
  }

  // Pull the FHIR base URL from the credential store so the proxy route
  // can compare it against the requested URL and exempt the configured server
  // from the SSRF guard (matches the regulator's createFhirContext shape).
  const baseUrl = (stored.fhirUrl || '').replace(/\/+$/, '');

  return { baseUrl, headers: buildFhirHeaders(authConfig) };
}

/**
 * Return FHIR headers built from the most-recently-cached auth config.
 * Use this only in the webhook handler where req.session is unavailable.
 *
 * @returns {object}
 */
export function getCachedFhirHeaders() {
  return buildFhirHeaders(_cachedAuthConfig);
}
