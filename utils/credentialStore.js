// utils/credentialStore.js
// Process-level credential store for the Submitter app.
//
// Survives browser close and session expiry — credentials live here for the
// lifetime of the Node.js process.  Cleared only when the user presses Reset
// or the server is stopped.
//
// Unlike the session (which dies on browser close), this store lets a returning
// user open /register and see their FHIR server URL and auth settings already
// filled in, without re-entering them.
//
// Usage:
//   import { getCredentials, saveCredentials, resetCredentials } from './credentialStore.js';

let _store = {
  fhirUrl:              '',   // last FHIR server base URL used
  fhirAuthType:         'none',
  fhirApiKey:           '',
  fhirBearerToken:      '',
  fhirCustomHeaderName: '',
  fhirCustomHeaderValue: ''
};

/**
 * Return a shallow copy of the current stored credentials.
 */
export function getCredentials() {
  return { ..._store };
}

/**
 * Persist credentials to the process-level store.
 * Accepts any subset of fields; missing fields keep their current values.
 * Strips trailing slashes from fhirUrl.
 */
export function saveCredentials(fields = {}) {
  if (fields.fhirUrl !== undefined)
    _store.fhirUrl              = (fields.fhirUrl || '').trim().replace(/\/+$/, '');
  if (fields.fhirAuthType !== undefined)
    _store.fhirAuthType         = fields.fhirAuthType || 'none';
  if (fields.fhirApiKey !== undefined)
    _store.fhirApiKey           = fields.fhirApiKey || '';
  if (fields.fhirBearerToken !== undefined)
    _store.fhirBearerToken      = fields.fhirBearerToken || '';
  if (fields.fhirCustomHeaderName !== undefined)
    _store.fhirCustomHeaderName = fields.fhirCustomHeaderName || '';
  if (fields.fhirCustomHeaderValue !== undefined)
    _store.fhirCustomHeaderValue= fields.fhirCustomHeaderValue || '';

  console.log(`💾  Credentials stored — url: ${_store.fhirUrl}, auth: ${_store.fhirAuthType}`);
}

/**
 * Wipe all stored credentials (called by the Reset route).
 */
export function resetCredentials() {
  _store = {
    fhirUrl:              '',
    fhirAuthType:         'none',
    fhirApiKey:           '',
    fhirBearerToken:      '',
    fhirCustomHeaderName: '',
    fhirCustomHeaderValue: ''
  };
  console.log('🗑️   Credential store cleared');
}
