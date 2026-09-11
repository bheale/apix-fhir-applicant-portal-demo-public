/**
 * APIX Demo Routes — Drop-in self-contained module
 * ─────────────────────────────────────────────────
 * Adds two routes with NO changes to any existing route or view:
 *
 *   GET  /demo/generate             — confirmation page (shows the form)
 *   POST /demo/generate-tasks       — generates ~50 APIX Tasks on FHIR server
 *   GET  /demo/annual-report        — annual reporting dashboard
 *
 * Drop-in: add to server.js (ESM or CJS both work):
 *
 *   // ESM  (type: "module" in package.json)
 *   import demoRoutes from './demo-routes.js';
 *   app.use(demoRoutes);
 *
 *   // CJS
 *   const demoRoutes = require('./demo-routes.js');
 *   app.use(demoRoutes);
 *
 * No new npm dependencies required.
 * ─────────────────────────────────────────────────
 */

import express from 'express';
import { createFhirContext } from './utils/fhir.js';
const router = express.Router();

/* ════════════════════════════════════════════════════════════════
   APIX REFERENCE DATA
   (sourced directly from the APIX IG CodeSystems)
   ════════════════════════════════════════════════════════════════ */

const APIX_CS_TASK  = 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-task-code';
const APIX_CS_BIZ   = 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-business-status';
const APIX_CS_CTD   = 'http://hl7.org/fhir/uv/apix/CodeSystem/ctd-section';
const APIX_PROFILE  = 'http://hl7.org/fhir/uv/apix/StructureDefinition/apix-task';

/* Task codes from CodeSystem-apix-task-code (fetched from live IG) */
const TASK_CODES = [
  { code: 'initial-submission',   display: 'Initial Submission',                      submitterInitiated: true  },
  { code: 'supplement',           display: 'Supplement / Variation',                  submitterInitiated: true  },
  { code: 'variation-type-ib',    display: 'Type IB Variation',                       submitterInitiated: true  },
  { code: 'response-to-questions',display: 'Response to Information Request',          submitterInitiated: true  },
  { code: 'information-request',  display: 'List of Questions / Information Request',  submitterInitiated: false },
  { code: 'validation-report',    display: 'Validation Report',                        submitterInitiated: false },
  { code: 'approval',             display: 'Approval Letter / Positive Decision',      submitterInitiated: false },
  { code: 'rejection',            display: 'Rejection / Negative Decision',            submitterInitiated: false },
  { code: 'withdrawal',           display: 'Withdrawal by Applicant',                  submitterInitiated: true  },
  { code: 'annual-report',        display: 'Periodic Safety Update Report / Annual Report', submitterInitiated: true },
  { code: 'request-payment',      display: 'Request Payment',                          submitterInitiated: false },
];

/**
 * businessStatus codes inferred from IG workflow + actual Task examples:
 * - scenario1-01: businessStatus = "submitted"
 * - scenario1-02: businessStatus = "validation-passed" (or "validation-failed")
 * - scenario1-05: businessStatus = "clock-stop"
 * - scenario1-07: businessStatus = "approved"
 * Additional codes from the IG CodeSystem and workflow text.
 */
const BUSINESS_STATUSES = [
  /* Stage 1 — Submission */
  { code: 'submitted',              display: 'Submitted',                    stage: 1, fhirStatus: 'requested'    },
  /* Stage 2 — Validation */
  { code: 'validation-in-progress', display: 'Validation In Progress',       stage: 2, fhirStatus: 'accepted'    },
  { code: 'validation-passed',      display: 'Validation Passed',            stage: 2, fhirStatus: 'accepted'    },
  { code: 'validation-failed',      display: 'Validation Failed',            stage: 2, fhirStatus: 'rejected'    },
  /* Stage 3 — Under Assessment */
  { code: 'under-assessment',       display: 'Under Assessment',             stage: 3, fhirStatus: 'in-progress' },
  { code: 'questions-raised',       display: 'Questions Raised',             stage: 3, fhirStatus: 'in-progress' },
  /* Stage 4 — Clock Stop / Awaiting Submitter */
  { code: 'clock-stop',             display: 'Clock Stop',                   stage: 4, fhirStatus: 'requested'   },
  { code: 'awaiting-response',      display: 'Awaiting Response',            stage: 4, fhirStatus: 'requested'   },
  /* Stage 5 — Response received / back to authority */
  { code: 'response-received',      display: 'Response Received',            stage: 5, fhirStatus: 'in-progress' },
  { code: 'assessment-resumed',     display: 'Assessment Resumed',           stage: 5, fhirStatus: 'in-progress' },
  /* Stage 6 — Final decision */
  { code: 'approved',               display: 'Approved',                     stage: 6, fhirStatus: 'completed'   },
  { code: 'rejected',               display: 'Rejected',                     stage: 6, fhirStatus: 'completed'   },
  { code: 'withdrawn',              display: 'Withdrawn',                    stage: 6, fhirStatus: 'completed'   },
];

/* CTD modules and representative sections from the IG Task examples */
const CTD_SECTIONS = [
  /* Module 1 — Administrative */
  { module: '1', moduleDisplay: 'Module 1 — Administrative & Prescribing Information',
    sections: [
      { code: '1.0',      display: 'Cover Letter' },
      { code: '1.2',      display: 'Application Form' },
      { code: '1.3.1',    display: 'Draft Labeling Text (Clean)' },
      { code: '1.3.2',    display: 'Mock-ups' },
      { code: '1.14.1.2', display: 'Annotated Draft Labeling Text' },
      { code: '1.14.1.3', display: 'Draft Labeling Text' },
    ]
  },
  /* Module 2 — Summaries */
  { module: '2', moduleDisplay: 'Module 2 — Quality, Preclinical & Clinical Summaries',
    sections: [
      { code: '2.3',      display: 'Quality Overall Summary (QOS)' },
      { code: '2.4',      display: 'Nonclinical Overview' },
      { code: '2.5',      display: 'Clinical Overview' },
      { code: '2.6',      display: 'Nonclinical Written and Tabulated Summaries' },
      { code: '2.7',      display: 'Clinical Summary' },
    ]
  },
  /* Module 3 — Quality (CMC) */
  { module: '3', moduleDisplay: 'Module 3 — Quality (Chemistry, Manufacturing & Controls)',
    sections: [
      { code: '3.2.P.1',   display: 'Description and Composition of Drug Product' },
      { code: '3.2.P.2',   display: 'Pharmaceutical Development' },
      { code: '3.2.P.3',   display: 'Manufacture' },
      { code: '3.2.P.4',   display: 'Control of Excipients' },
      { code: '3.2.P.5',   display: 'Control of Drug Product' },
      { code: '3.2.P.8.1', display: 'Stability Summary and Conclusion' },
      { code: '3.2.P.8.3', display: 'Stability Data' },
      { code: '3.2.S.7',   display: 'Stability (Drug Substance)' },
    ]
  },
  /* Module 4 — Safety */
  { module: '4', moduleDisplay: 'Module 4 — Nonclinical Study Reports',
    sections: [
      { code: '4.2.1',    display: 'Pharmacology Study Reports' },
      { code: '4.2.2',    display: 'Pharmacokinetics Study Reports' },
      { code: '4.2.3',    display: 'Toxicology Study Reports' },
    ]
  },
  /* Module 5 — Clinical */
  { module: '5', moduleDisplay: 'Module 5 — Clinical Study Reports',
    sections: [
      { code: '5.2',      display: 'Tabular Listing of Clinical Studies' },
      { code: '5.3.1',    display: 'Reports of Biopharmaceutic Studies' },
      { code: '5.3.5',    display: 'Reports of Efficacy and Safety Studies' },
      { code: '5.3.7',    display: 'Case Report Forms and Individual Patient Listings' },
      { code: '5.4',      display: 'Literature References' },
    ]
  },
];

/* Synthetic pharma companies — submitters.
   NOTE: 'id' here is a display key only; the real FHIR server ID is
   assigned at POST time and stored in serverOrgIds during generation. */
const SUBMITTERS = [
  { id: 'org-synthpharma-ag',   display: 'SynthPharma AG',            country: 'CH' },
  { id: 'org-novabio-ltd',      display: 'NovaBio Ltd',               country: 'GB' },
  { id: 'org-regulatix-inc',    display: 'Regulatix Inc.',            country: 'US' },
  { id: 'org-alphamedix-gmbh',  display: 'AlphaMedix GmbH',          country: 'DE' },
  { id: 'org-pharmaforce-sa',   display: 'PharmaForce SA',            country: 'FR' },
  { id: 'org-biolinkx-bv',      display: 'BioLinkX BV',              country: 'NL' },
];

/* Authority — single regulator.
   'id' is a display key; real server ID populated at POST time. */
const AUTHORITY = { id: 'org-health-authority', display: 'Health Regulatory Authority' };

/* Synthetic drug product names */
const DRUG_NAMES = [
  'Examplovir 50mg Tablets', 'Synthelin 10mg/mL Solution', 'NovaCoat Capsules 100mg',
  'AlphaStatin 20mg Film-coated Tablets', 'BioLinkPen 1mg/mL Injection',
  'RegulaPatch 5mg Transdermal', 'Synthetase 250mg Powder', 'NovaDerm 0.5% Cream',
  'PharmaForce 2mg Sublingual Tablets', 'Examplidine 75mg Extended Release',
];

/* Procedure IDs */
const PROC_PREFIXES = ['PROC', 'PSUR', 'VAR', 'NDA', 'MAA', 'SUP'];

/* ════════════════════════════════════════════════════════════════
   UTILITY / RANDOMISATION HELPERS
   ════════════════════════════════════════════════════════════════ */

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Build a minimal valid single-page PDF as a Buffer — no npm dependencies.
 * HAPI FHIR stores Binary bytes as-is; this is sufficient for demo purposes.
 * Byte offsets in the xref table are computed dynamically so the structure
 * is always well-formed.
 */
function buildMinimalPdf() {
  const s1 = '%PDF-1.4\n';
  const s2 = '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n';
  const s3 = '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n';
  const s4 = '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\n';
  const off1 = s1.length;
  const off2 = off1 + s2.length;
  const off3 = off2 + s3.length;
  const xrefOff = off3 + s4.length;
  const xref =
    'xref\n0 4\n' +
    '0000000000 65535 f \n' +
    String(off1).padStart(10, '0') + ' 00000 n \n' +
    String(off2).padStart(10, '0') + ' 00000 n \n' +
    String(off3).padStart(10, '0') + ' 00000 n \n' +
    'trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n' +
    xrefOff + '\n%%EOF\n';
  return Buffer.from(s1 + s2 + s3 + s4 + xref, 'utf8');
}

/**
 * Generate a consistent timestamp window.
 * All Tasks fit within a 14-day window ending "now".
 * authoredOn < lastModified always.
 * @param {Date} windowStart - start of the 14-day window
 * @returns {object} { authoredOn, lastModified, durationDays }
 */
function genTimestamps(windowStart) {
  const now = new Date();
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  const start = windowStart || new Date(now - windowMs);

  // authoredOn: random moment in the window
  const authoredOn = new Date(start.getTime() + Math.random() * (now - start));

  // lastModified: between authoredOn and now
  const lastModified = new Date(
    authoredOn.getTime() + Math.random() * (now - authoredOn)
  );

  const durationDays = Math.round((lastModified - authoredOn) / (24 * 60 * 60 * 1000));

  return {
    authoredOn:    authoredOn.toISOString(),
    lastModified:  lastModified.toISOString(),
    durationDays,
  };
}

/**
 * Pick a businessStatus appropriate to the Task code and a random workflow stage.
 * Completed tasks (approval/rejection/withdrawal) always use a Stage 6 status.
 * Information-request tasks always use clock-stop or awaiting-response.
 */
function pickBusinessStatus(taskCode, forcedStage) {
  let candidates = BUSINESS_STATUSES;

  if (taskCode === 'approval') {
    candidates = BUSINESS_STATUSES.filter(b => b.code === 'approved');
  } else if (taskCode === 'rejection') {
    candidates = BUSINESS_STATUSES.filter(b => b.code === 'rejected');
  } else if (taskCode === 'withdrawal') {
    candidates = BUSINESS_STATUSES.filter(b => b.code === 'withdrawn');
  } else if (taskCode === 'information-request') {
    candidates = BUSINESS_STATUSES.filter(b => ['clock-stop','awaiting-response'].includes(b.code));
  } else if (taskCode === 'response-to-questions') {
    candidates = BUSINESS_STATUSES.filter(b => ['response-received','assessment-resumed','under-assessment'].includes(b.code));
  } else if (taskCode === 'validation-report') {
    candidates = BUSINESS_STATUSES.filter(b => ['validation-passed','validation-failed'].includes(b.code));
  } else if (forcedStage) {
    candidates = BUSINESS_STATUSES.filter(b => b.stage === forcedStage);
  }

  return rand(candidates) || rand(BUSINESS_STATUSES);
}

/**
 * Pick 1–4 CTD sections from 1–2 modules for Task.input.
 * Returns metadata only — NO DocumentReference IDs.
 * The POST route creates real DocumentReference resources first,
 * then substitutes their server-assigned IDs into Task.input.
 */
function pickInputDocs(taskCode) {
  const inputs = [];

  // Cover letter always included for initial submissions
  if (['initial-submission','supplement','variation-type-ib'].includes(taskCode)) {
    inputs.push({
      ctd: { code: '1.0', display: 'Cover Letter' },
      module: '1',
    });
  }

  // Add 1–4 more sections from 1–2 random modules
  const numModules = randInt(1, 2);
  const modules = [...CTD_SECTIONS].sort(() => Math.random() - 0.5).slice(0, numModules);

  for (const mod of modules) {
    const sects = [...mod.sections].sort(() => Math.random() - 0.5).slice(0, randInt(1, 3));
    for (const sect of sects) {
      if (!inputs.find(i => i.ctd.code === sect.code)) {
        inputs.push({
          ctd: sect,
          module: mod.module,
        });
      }
    }
  }

  return inputs;
}

/**
 * Build output array for completed or in-progress Tasks.
 * outputDocRefId must be a real server-assigned DocumentReference ID
 * that was POSTed before this Task is POSTed.
 * Pass null to omit output entirely (e.g. for in-progress tasks without a decision doc).
 */
function buildOutputs(bizStatus, outputDocRefId) {
  if (!outputDocRefId) return [];
  if (['approved','rejected','validation-passed','response-received','assessment-resumed'].includes(bizStatus.code)) {
    return [{
      type: { coding: [{ system: APIX_CS_CTD, code: 'regulatory-document', display: 'Regulatory Document' }] },
      valueReference: { reference: `DocumentReference/${outputDocRefId}`, display: 'Decision Document' },
    }];
  }
  return [];
}

/**
 * Assemble one APIX Task resource.
 * opts.requesterServerId and opts.ownerServerId must be real server-assigned
 * Organization IDs (from prior POSTs), not the local display keys.
 * opts.inputDocRefIds is an array of real server-assigned DocumentReference IDs,
 * parallel to the array returned by pickInputDocs().
 * opts.outputDocRefId is a real server-assigned DocumentReference ID or null.
 */
function buildTask(opts) {
  const {
    taskCode,
    bizStatus,
    submitter,
    drugName,
    procedureId,
    groupId,
    basedOnRef,
    timestamps,
    requesterServerId,
    ownerServerId,
    inputDocRefIds,
    outputDocRefId,
  } = opts;

  const isSubmitterTask = taskCode.submitterInitiated;
  const requesterDisplay = isSubmitterTask ? submitter.display  : AUTHORITY.display;
  const ownerDisplay     = isSubmitterTask ? AUTHORITY.display  : submitter.display;

  // requesterServerId / ownerServerId are real IDs from prior Organization POSTs
  const requesterRef = `Organization/${requesterServerId}`;
  const ownerRef     = `Organization/${ownerServerId}`;

  const inputMeta = pickInputDocs(taskCode.code);
  const outputs   = buildOutputs(bizStatus, outputDocRefId || null);

  const task = {
    resourceType: 'Task',
    meta: {
      profile:     [APIX_PROFILE],
      lastUpdated: timestamps.lastModified,
    },
    language: 'en',
    identifier: [
      {
        use:  'official',
        type: { coding: [{ system: 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-demo', code: 'apixtaskinstance', display: 'APIX Task Instance ID' }] },
        system: 'http://example.org/health-authority/task-id',
        value: `urn:uuid:${uuid()}`,
      },
    ],
    groupIdentifier: {
      use:    'official',
      system: 'http://example.org/health-authority/work-flow-group-id',
      value:  groupId,
    },
    status: bizStatus.fhirStatus,
    businessStatus: {
      coding: [{ system: APIX_CS_BIZ, code: bizStatus.code, display: bizStatus.display }],
    },
    intent:   'proposal',
    priority: rand(['routine', 'routine', 'routine', 'urgent']),
    code: {
      coding: [{ system: APIX_CS_TASK, code: taskCode.code, display: taskCode.display }],
    },
    description: `${taskCode.display} — ${drugName} (${procedureId})`,
    authoredOn:   timestamps.authoredOn,
    lastModified: timestamps.lastModified,
    requester: { reference: requesterRef, display: requesterDisplay },
    owner:     { reference: ownerRef,     display: ownerDisplay     },
    // Build Task.input using real server-assigned DocumentReference IDs.
    // inputDocRefIds is parallel to inputMeta; if a slot has no ID yet (creation
    // failed), that input entry is omitted rather than referencing a missing resource.
    input: inputMeta
      .map((item, idx) => {
        const docId = inputDocRefIds && inputDocRefIds[idx];
        if (!docId) return null;
        return {
          type: { coding: [{ system: APIX_CS_CTD, code: item.ctd.code, display: item.ctd.display }] },
          valueReference: { reference: `DocumentReference/${docId}`, display: item.ctd.display },
        };
      })
      .filter(Boolean),
  };

  if (outputs.length) task.output = outputs;
  if (basedOnRef)     task.basedOn = [{ reference: basedOnRef, display: 'Parent Task' }];

  // requestedPeriod for information-request tasks (7-day answer window)
  if (taskCode.code === 'information-request') {
    const start = new Date(timestamps.authoredOn);
    const end   = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    task.requestedPeriod = { start: start.toISOString(), end: end.toISOString() };
  }

  return task;
}

/**
 * Build a chain plan — an ordered array of step descriptors.
 * Does NOT call buildTask here because real server IDs for Organizations
 * and DocumentReferences are not yet known.
 * The POST route calls buildTask for each step after creating those resources.
 */
function buildChain(windowStart, submitter, drugName, procedureId, groupId) {
  const chainPatterns = [
    ['initial-submission', 'validation-report', 'information-request', 'response-to-questions', 'approval'],
    ['initial-submission', 'validation-report', 'approval'],
    ['initial-submission', 'information-request', 'response-to-questions', 'approval'],
    ['supplement',         'validation-report', 'information-request', 'response-to-questions', 'rejection'],
    ['variation-type-ib',  'validation-report', 'approval'],
    ['variation-type-ib',  'information-request', 'response-to-questions', 'approval'],
    ['annual-report',      'validation-report', 'information-request', 'response-to-questions', 'approval'],
    ['initial-submission', 'validation-report', 'request-payment', 'approval'],
  ];

  const chainLen = randInt(2, 5);
  const pattern  = rand(chainPatterns).slice(0, chainLen);

  const now      = new Date();
  const winMs    = 14 * 24 * 60 * 60 * 1000;
  const winStart = windowStart || new Date(now - winMs);
  const stepMs   = Math.floor((now - winStart) / (pattern.length + 1));

  return pattern.map((codeStr, i) => {
    const taskCode = TASK_CODES.find(t => t.code === codeStr) || TASK_CODES[0];

    const stepStart    = new Date(winStart.getTime() + i * stepMs);
    const stepEnd      = new Date(winStart.getTime() + (i + 1) * stepMs - 1000);
    const authoredOn   = new Date(stepStart.getTime() + Math.random() * (stepEnd - stepStart));
    const lastModified = new Date(authoredOn.getTime() + Math.random() * (stepEnd - authoredOn));

    const isLast   = i === pattern.length - 1;
    const stage    = isLast ? 6 : Math.min(i + 1, 5);
    const bizStatus = pickBusinessStatus(taskCode.code, isLast ? null : stage);

    return {
      taskCode,
      bizStatus,
      timestamps: {
        authoredOn:   authoredOn.toISOString(),
        lastModified: lastModified.toISOString(),
        durationDays: Math.round((lastModified - authoredOn) / 86400000),
      },
    };
  });
}

/**
 * Generate the full set of ~50 procedure plans.
 * Returns an array of group descriptors — metadata only, no Task objects,
 * no server IDs. The POST route does all FHIR POSTing.
 */
function generateAllTasks() {
  const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const all = [];

  // 8 procedure chains (covering most of the ~50 Tasks)
  for (let c = 0; c < 8; c++) {
    const submitter   = rand(SUBMITTERS);
    const drugName    = rand(DRUG_NAMES);
    const procedureId = `${rand(PROC_PREFIXES)}-2025-${String(randInt(10000, 99999))}`;
    const groupId     = `urn:uuid:${uuid()}`;
    const steps       = buildChain(windowStart, submitter, drugName, procedureId, groupId);
    all.push({ type: 'chain', steps, submitter, drugName, procedureId, groupId });
  }

  // ~12 standalone Tasks (single-step, various codes)
  const standaloneCount = randInt(10, 14);
  for (let s = 0; s < standaloneCount; s++) {
    const submitter   = rand(SUBMITTERS);
    const drugName    = rand(DRUG_NAMES);
    const procedureId = `${rand(PROC_PREFIXES)}-2025-${String(randInt(10000, 99999))}`;
    const groupId     = `urn:uuid:${uuid()}`;
    const taskCode    = rand(TASK_CODES);
    const bizStatus   = pickBusinessStatus(taskCode.code, null);
    const timestamps  = genTimestamps(windowStart);
    all.push({
      type: 'standalone',
      steps: [{ taskCode, bizStatus, timestamps }],
      submitter,
      drugName,
      procedureId,
      groupId,
    });
  }

  return all;
}

/* ════════════════════════════════════════════════════════════════
   ROUTES
   ════════════════════════════════════════════════════════════════ */

/**
 * GET /demo/generate
 * Confirmation page — lets user enter FHIR URL then trigger generation.
 */
router.get('/demo/generate', (req, res) => {
  // We render inline HTML to avoid touching any existing view files.
  const fhirUrl = req.session?.fhirBase || req.query.fhirUrl || 'http://localhost:8080/fhir';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generate APIX Demo Tasks</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="https://unpkg.com/@phosphor-icons/web@2.0.3/src/index.js" defer></script>
  <style>
    .non-compliant-banner {
      background: #7f1d1d;
      color: #fef2f2;
      border: 3px solid #dc2626;
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 32px;
      text-align: center;
    }
    .non-compliant-banner .banner-icon {
      font-size: 3rem;
      display: block;
      margin-bottom: 12px;
      color: #fca5a5;
    }
    .non-compliant-banner h1 {
      font-size: 1.75rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0 0 12px;
      color: #fef2f2;
      line-height: 1.2;
    }
    .non-compliant-banner p {
      font-size: 1rem;
      line-height: 1.65;
      color: #fecaca;
      margin: 0;
    }
    .non-compliant-banner strong {
      color: #fff;
    }
    .deprecated-content {
      opacity: 0.45;
      filter: grayscale(30%);
      pointer-events: none;
      user-select: none;
      position: relative;
    }
    .deprecated-content::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 8px;
      pointer-events: none;
    }
    .deprecated-label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #92400e;
      background: #fef3c7;
      border: 1px solid #d97706;
      border-radius: 4px;
      padding: 2px 8px;
      margin-left: 8px;
      vertical-align: middle;
    }
  </style>
</head>
<body>
<div class="app-shell">
  <div class="main-content" style="max-width:680px; margin:var(--space-12) auto;">

    <!-- ═══ NON-COMPLIANCE WARNING BANNER ═══ -->
    <div class="non-compliant-banner">
      <span class="banner-icon"><i class="ph ph-warning-octagon"></i></span>
      <h1>⚠ Not APIX Compliant</h1>
      <p>
        These demo tasks are <strong>not compliant with the current APIX FHIR Implementation Guide.</strong><br>
        They exist solely to <strong>populate the dashboard for UI testing purposes.</strong>
      </p>
      <p style="margin-top:14px; font-size:0.9rem;">
        The <strong>businessStatus codes</strong> and <strong>workflow patterns</strong> used here follow
        an <strong>older pattern no longer recommended</strong> by the APIX FHIR IG.
        Do not use these Tasks as reference implementations or conformance examples.
      </p>
    </div>
    <!-- ══════════════════════════════════════ -->

    <div class="page-header">
      <div class="page-title">
        <i class="ph ph-flask"></i> Generate APIX Demo Tasks
        <span class="deprecated-label">Deprecated Pattern</span>
      </div>
      <div class="page-subtitle">Creates ~50 Tasks on the target FHIR server for dashboard population only. Workflow patterns do not reflect current APIX IG guidance.</div>
    </div>
    <div class="deprecated-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><i class="ph ph-info"></i> What will be generated</div>
        </div>
        <div style="font-size:0.85rem; line-height:1.8; color:var(--color-text-muted);">
          <ul style="padding-left:1.2em; margin:0;">
            <li>8 multi-step <strong>basedOn chains</strong> (2–5 Tasks each) representing full regulatory procedures</li>
            <li>10–14 <strong>standalone Tasks</strong> at random workflow stages</li>
            <li>All 11 APIX Task codes: initial-submission, supplement, variation-type-ib, information-request, response-to-questions, validation-report, approval, rejection, withdrawal, annual-report, request-payment</li>
            <li>All APIX businessStatus codes: submitted → validation → under-assessment → clock-stop → response-received → approved / rejected / withdrawn</li>
            <li>6 synthetic pharma submitters × 1 Health Regulatory Authority</li>
            <li>CTD Module 1–5 input documents with real CTD section codes</li>
            <li>All timestamps internally consistent within a 14-day window</li>
          </ul>
        </div>
      </div>
    </div><!-- end deprecated-content -->
    <form method="POST" action="/demo/generate-tasks" class="form-section" style="margin-top:var(--space-4);">
      <h3><i class="ph ph-link"></i> FHIR Server</h3>
      <label>
        FHIR Base URL
        <input name="fhirUrl" value="${fhirUrl}" required placeholder="https://your-fhir-server.org/fhir">
      </label>
      <div style="display:flex; gap:var(--space-3); margin-top:var(--space-2);">
        <button type="submit">
          <i class="ph ph-play"></i> Generate ~50 Tasks
        </button>
        <a href="/demo/annual-report?fhirUrl=${encodeURIComponent(fhirUrl)}" class="btn btn-ghost">
          <i class="ph ph-chart-bar"></i> View Annual Report
        </a>
      </div>
    </form>

  </div>
</div>
</body>
</html>`);
});

/**
 * POST /demo/generate-tasks
 *
 * Sequential creation order (Option A):
 *   1. POST Authority Organization  → get server ID
 *   2. POST each unique Submitter Organization → get server IDs
 *   3. For each procedure group:
 *      a. For each step that needs input DocumentReferences → POST them → get IDs
 *      b. For each step that needs an output DocumentReference → POST it → get ID
 *      c. POST the Task using all real server IDs
 *      d. Wire basedOn using the previous step's server-assigned Task ID
 */
router.post('/demo/generate-tasks', async (req, res) => {
  const fhirUrl = (req.body?.fhirUrl || req.query?.fhirUrl || '').replace(/\/+$/, '');
  if (!fhirUrl) return res.status(400).send('fhirUrl is required');

  const ctx = createFhirContext(req.session);

  const results = [];
  const errors  = [];

  /* ── helper: POST one resource, return the created resource or null ── */
  async function postResource(resource, extraHeaders = {}) {
    const type = resource.resourceType;
    try {
      const r = await fetch(`${fhirUrl}/${type}`, {
        method:  'POST',
        headers: { ...ctx.headers, ...extraHeaders },
        body:    JSON.stringify(resource),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        errors.push({ type, status: r.status, message: txt.slice(0, 300) });
        return null;
      }
      return await r.json();
    } catch (err) {
      errors.push({ type, status: 0, message: err.message });
      return null;
    }
  }

  /* ── helper: POST a Binary (minimal PDF), return server ID or null ── */
  async function postBinary(pdfBuffer) {
    try {
      const r = await fetch(`${fhirUrl}/Binary`, {
        method:  'POST',
        headers: { ...ctx.headers, 'Content-Type': 'application/pdf' },
        body:    pdfBuffer,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        errors.push({ type: 'Binary', status: r.status, message: txt.slice(0, 300) });
        return null;
      }
      const created = await r.json();
      return created.id || null;
    } catch (err) {
      errors.push({ type: 'Binary', status: 0, message: err.message });
      return null;
    }
  }

  /* ── helper: POST Binary → DocumentReference, return server ID or null ── */
  async function postDocRef(ctdCode, ctdDisplay, authorOrgId, drugName) {
    // POST the Binary first so DocumentReference.content[0].attachment.url
    // points to a real Binary resource (not a urn:uuid: placeholder).
    const binaryId = await postBinary(buildMinimalPdf());
    const dr = {
      resourceType: 'DocumentReference',
      status: 'current',
      type: {
        coding: [{ system: APIX_CS_CTD, code: ctdCode, display: ctdDisplay }],
      },
      subject: { display: drugName },
      author:  authorOrgId ? [{ reference: `Organization/${authorOrgId}` }] : [],
      content: [{
        attachment: {
          contentType: 'application/pdf',
          title: `${ctdDisplay} — ${drugName}`,
          // Use real Binary reference if creation succeeded; fall back to
          // placeholder only if the Binary POST failed (already logged to errors[]).
          url: binaryId ? `Binary/${binaryId}` : `urn:uuid:${uuid()}`,
        },
      }],
    };
    const created = await postResource(dr);
    return created ? created.id : null;
  }

  /* ════════════════════════════════════════════════════════════
     STEP 1 — POST Authority Organization
     ════════════════════════════════════════════════════════════ */
  const authorityOrg = await postResource({
    resourceType: 'Organization',
    name:   AUTHORITY.display,
    active: true,
    identifier: [{
      system: 'http://example.org/health-authority/org-id',
      value:  'HA-001',
    }],
  });
  if (!authorityOrg) {
    return res.status(500).send('Could not create Authority Organization on FHIR server. Check server URL and try again.');
  }
  const authorityServerId = authorityOrg.id;

  /* ════════════════════════════════════════════════════════════
     STEP 2 — POST each unique Submitter Organization
     ════════════════════════════════════════════════════════════ */
  // serverOrgIds maps local display key → server-assigned ID
  const serverOrgIds = {};

  const groups = generateAllTasks();

  // Collect unique submitters referenced across all groups
  const usedSubmitterKeys = new Set(groups.map(g => g.submitter.id));

  for (const submitter of SUBMITTERS.filter(s => usedSubmitterKeys.has(s.id))) {
    const created = await postResource({
      resourceType: 'Organization',
      name:   submitter.display,
      active: true,
      identifier: [{
        system: 'http://example.org/health-authority/org-id',
        value:  submitter.id,
      }],
      address: [{ country: submitter.country }],
    });
    if (created) {
      serverOrgIds[submitter.id] = created.id;
    }
    // If a submitter org fails to create, Tasks for that submitter will be
    // skipped (postResource already pushed to errors[]).
  }

  /* ════════════════════════════════════════════════════════════
     STEP 3 — For each group, create DocRefs then Tasks in order
     ════════════════════════════════════════════════════════════ */
  for (const group of groups) {
    const submitterServerId = serverOrgIds[group.submitter.id];
    if (!submitterServerId) {
      // Submitter org creation failed — skip this group's Tasks
      errors.push({
        type: 'Task',
        status: 0,
        message: `Skipped group ${group.procedureId} — submitter org ${group.submitter.id} was not created`,
      });
      continue;
    }

    let parentRef = null;

    for (const step of group.steps) {
      const { taskCode, bizStatus, timestamps } = step;
      const isSubmitterTask = taskCode.submitterInitiated;

      const requesterServerId = isSubmitterTask ? submitterServerId : authorityServerId;
      const ownerServerId     = isSubmitterTask ? authorityServerId : submitterServerId;

      // The org that authors DocumentReferences is the requester
      const docAuthorId = requesterServerId;

      /* ── 3a. POST input DocumentReferences ── */
      const inputMeta    = pickInputDocs(taskCode.code);
      const inputDocRefIds = [];
      for (const item of inputMeta) {
        const docId = await postDocRef(item.ctd.code, item.ctd.display, docAuthorId, group.drugName);
        inputDocRefIds.push(docId); // null if creation failed — buildTask skips null slots
      }

      /* ── 3b. POST output DocumentReference (for terminal/decision tasks) ── */
      let outputDocRefId = null;
      const needsOutputDoc = ['approved','rejected','validation-passed','response-received','assessment-resumed']
        .includes(bizStatus.code);
      if (needsOutputDoc) {
        outputDocRefId = await postDocRef(
          'regulatory-document',
          'Decision Document',
          authorityServerId,
          group.drugName
        );
      }

      /* ── 3c. Build and POST the Task using all real server IDs ── */
      const task = buildTask({
        taskCode,
        bizStatus,
        submitter:          group.submitter,
        drugName:           group.drugName,
        procedureId:        group.procedureId,
        groupId:            group.groupId,
        basedOnRef:         parentRef,
        timestamps,
        requesterServerId,
        ownerServerId,
        inputDocRefIds,
        outputDocRefId,
      });

      const createdTask = await postResource(task);
      if (!createdTask) continue;

      /* ── 3d. Wire basedOn for next step ── */
      parentRef = `Task/${createdTask.id}`;

      results.push({
        id:        createdTask.id,
        code:      taskCode.code,
        display:   taskCode.display,
        bizStatus: bizStatus.display,
        fhirStatus: task.status,
        drug:      group.drugName,
        procedure: group.procedureId,
        isChain:   group.type === 'chain',
        chainLen:  group.steps.length,
        basedOn:   task.basedOn?.[0]?.reference || null,
      });
    }
  }

  /* ── Summary counts ── */
  const byCode = {};
  const byBiz  = {};
  for (const r of results) {
    byCode[r.code]      = (byCode[r.code]      || 0) + 1;
    byBiz[r.bizStatus]  = (byBiz[r.bizStatus]  || 0) + 1;
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Demo Tasks Generated</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="https://unpkg.com/@phosphor-icons/web@2.0.3/src/index.js" defer></script>
</head>
<body>
<div class="app-shell">
<div class="main-content" style="max-width:900px; margin:var(--space-8) auto;">

  <div class="page-header">
    <div class="page-title"><i class="ph ph-check-circle"></i> APIX Demo Tasks Generated</div>
    <div class="page-subtitle">
      <strong>${results.length}</strong> Tasks created on
      <code style="font-family:var(--font-mono)">${fhirUrl}</code>
      · Authority Org ID: <code style="font-family:var(--font-mono)">${authorityServerId}</code>
      ${errors.length ? `· <span style="color:var(--color-danger)">${errors.length} errors</span>` : ''}
    </div>
  </div>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:var(--space-4); margin-bottom:var(--space-5);">
    <div class="card">
      <div class="card-header"><div class="card-title"><i class="ph ph-tag"></i> By Task Code</div></div>
      <table><thead><tr><th>Code</th><th style="text-align:right;">Count</th></tr></thead>
      <tbody>${Object.entries(byCode).map(([k,v]) =>
        `<tr><td style="font-size:0.82rem;font-family:var(--font-mono)">${k}</td>
             <td style="text-align:right;"><span class="badge badge-info">${v}</span></td></tr>`
      ).join('')}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title"><i class="ph ph-activity"></i> By Business Status</div></div>
      <table><thead><tr><th>Status</th><th style="text-align:right;">Count</th></tr></thead>
      <tbody>${Object.entries(byBiz).map(([k,v]) =>
        `<tr><td style="font-size:0.82rem;">${k}</td>
             <td style="text-align:right;"><span class="badge badge-neutral">${v}</span></td></tr>`
      ).join('')}</tbody>
      </table>
    </div>
  </div>

  ${errors.length ? `
  <div class="alert alert-danger mb-4">
    <i class="ph ph-warning-circle"></i>
    <div>
      <strong>${errors.length} errors during generation.</strong><br>
      <span style="font-size:0.8rem;opacity:0.85;">
        ${errors.slice(0,5).map(e => `${e.type}: HTTP ${e.status} — ${e.message.slice(0,120)}`).join('<br>')}
      </span>
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-header">
      <div class="card-title"><i class="ph ph-list-bullets"></i> Created Tasks (${results.length})</div>
    </div>
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>Task ID</th><th>Code</th><th>businessStatus</th>
          <th>Status</th><th>Drug</th><th>Chain</th>
        </tr></thead>
        <tbody>
          ${results.map(r => `
          <tr>
            <td style="font-family:var(--font-mono);font-size:0.78rem;">${r.id}</td>
            <td style="font-family:var(--font-mono);font-size:0.78rem;">${r.code}</td>
            <td><span class="badge ${
              r.bizStatus?.includes('Approved')  ? 'badge-success' :
              r.bizStatus?.includes('Rejected') || r.bizStatus?.includes('Failed') ? 'badge-danger' :
              r.bizStatus?.includes('Clock')    || r.bizStatus?.includes('Awaiting') ? 'badge-warning' :
              'badge-info'}">${r.bizStatus || '—'}</span></td>
            <td><span class="badge ${
              r.fhirStatus === 'completed'   ? 'badge-success' :
              r.fhirStatus === 'in-progress' || r.fhirStatus === 'accepted' ? 'badge-warning' :
              r.fhirStatus === 'rejected'    ? 'badge-danger' : 'badge-info'}">${r.fhirStatus}</span></td>
            <td style="font-size:0.8rem;">${r.drug}</td>
            <td style="font-size:0.78rem;color:var(--color-text-muted);">
              ${r.isChain ? `step ${results.filter(x=>x.procedure===r.procedure).indexOf(r)+1}/${r.chainLen}` : 'standalone'}
              ${r.basedOn ? `<br><span style="font-family:var(--font-mono);font-size:0.7rem;">${r.basedOn}</span>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div style="display:flex; gap:var(--space-3); margin-top:var(--space-5);">
    <a href="/demo/annual-report?fhirUrl=${encodeURIComponent(fhirUrl)}" class="btn btn-primary">
      <i class="ph ph-chart-bar"></i> View Annual Report Dashboard
    </a>
    <a href="/demo/generate" class="btn btn-ghost">
      <i class="ph ph-arrow-clockwise"></i> Generate Again
    </a>
  </div>

</div>
</div>
</body>
</html>`);
});

/**
 * GET /demo/annual-report
 * Fetches Tasks from FHIR server and renders the annual reporting dashboard.
 */
router.get('/demo/annual-report', async (req, res) => {
  const fhirUrl = (req.query?.fhirUrl || req.session?.fhirBase || '').replace(/\/+$/, '');

  let tasks = [];
  let fetchError = null;

  if (fhirUrl) {
    try {
      // Fetch up to 200 Tasks from the FHIR server
      const url = `${fhirUrl}/Task?_count=200&_sort=-_lastUpdated`;
      const r   = await fetch(url, { headers: { 'Accept': 'application/fhir+json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bundle = await r.json();
      tasks = (bundle.entry || []).map(e => e.resource).filter(Boolean);
    } catch (err) {
      fetchError = err.message;
    }
  }

  // Pass raw tasks as JSON to EJS
  res.render('demo/annual-report', {
    fhirUrl,
    tasks,
    fetchError,
    tasksJson: JSON.stringify(tasks),
    pageTitle: 'Annual Reporting Dashboard',
    // Pre-computed summaries for the EJS template
    summary: computeSummary(tasks),
  });
});

/* ── Summary computation (server-side for EJS tables) ─────── */
function computeSummary(tasks) {
  if (!tasks.length) return null;

  const byBizStatus = {};
  const byFhirStatus = {};
  const byCode = {};
  const bySubmitter = {};
  const byModule = {};
  const byStage = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let totalDurationDays = 0;
  let durationCount = 0;
  let authorityTasks = 0;
  let submitterTasks = 0;

  for (const t of tasks) {
    const code    = t.code?.coding?.[0]?.code   || 'unknown';
    const biz     = t.businessStatus?.coding?.[0]?.code || 'unknown';
    const bizDisp = t.businessStatus?.coding?.[0]?.display || biz;
    const fhir    = t.status || 'unknown';
    const req     = t.requester?.reference?.split('/').pop() || 'unknown';
    const reqDisp = t.requester?.display || req;

    byBizStatus[bizDisp]  = (byBizStatus[bizDisp]  || 0) + 1;
    byFhirStatus[fhir]    = (byFhirStatus[fhir]    || 0) + 1;
    byCode[code]          = (byCode[code]           || 0) + 1;
    bySubmitter[reqDisp]  = (bySubmitter[reqDisp]   || 0) + 1;

    // CTD modules in input
    for (const inp of (t.input || [])) {
      const section = inp.type?.coding?.[0]?.code || '';
      const mod = section.split('.')[0];
      if (/^[1-5]$/.test(mod)) {
        byModule[`Module ${mod}`] = (byModule[`Module ${mod}`] || 0) + 1;
      }
    }

    // Stage
    const bs = BUSINESS_STATUSES.find(b => b.code === biz);
    if (bs) byStage[bs.stage] = (byStage[bs.stage] || 0) + 1;

    // Requester type — compare by display name (set in buildTask from AUTHORITY.display).
    // req is the server-assigned ID and cannot be matched against a local display key.
    if (reqDisp === AUTHORITY.display) authorityTasks++;
    else submitterTasks++;

    // Turnaround
    if (t.authoredOn && t.lastModified) {
      const d = (new Date(t.lastModified) - new Date(t.authoredOn)) / 86400000;
      if (d >= 0) { totalDurationDays += d; durationCount++; }
    }
  }

  return {
    total: tasks.length,
    byBizStatus,
    byFhirStatus,
    byCode,
    bySubmitter,
    byModule,
    byStage,
    authorityTasks,
    submitterTasks,
    avgTurnaroundDays: durationCount ? (totalDurationDays / durationCount).toFixed(1) : 'N/A',
    completedCount:    (byFhirStatus['completed'] || 0),
    inProgressCount:   (byFhirStatus['in-progress'] || 0),
    requestedCount:    (byFhirStatus['requested'] || 0),
  };
}

export default router;
