import express from "express";
import fs from "fs";
import crypto from "crypto";
import axios from "axios";

import expressLayouts from "express-ejs-layouts";

import multer from "multer";
import { ctdModules } from "./utils/ctdModules.js";
import { getBusinessStatus } from "./utils/businessStatusLoader.js";
import { getCtdSections } from "./utils/ctdSectionsLoader.js";
import demoRoutes from './demo-routes.js';

const upload = multer();

const app = express();

//for testing locally
import cors from "cors";
import session from 'express-session';
import { createFhirContext, getCachedFhirHeaders } from './utils/fhir.js';
import { getCredentials, saveCredentials, resetCredentials } from './utils/credentialStore.js';
app.use(cors());
//make sure to comment out above before deploy

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
//app.use(express.json());
app.use(express.json({
  type: [
    'application/json',
    'application/fhir+json',
    'application/*+json'
  ]
}));

app.use(express.static("public"));

app.use(expressLayouts);

// ── Session middleware ─────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'fhir-apix-dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));

// Attach FHIR auth context to every request.
// Updates the module-level cache in utils/fhir.js so the webhook handler
// (which has no session) can reuse the last-seen credentials.
app.use((req, res, next) => {
  // If the session has no auth config (new tab, browser restart, session expired),
  // restore it from the process-level credential store so the user doesn't have
  // to re-enter credentials until they explicitly press Reset.
  const stored = getCredentials();
  if (!req.session.fhirAuthType && stored.fhirAuthType && stored.fhirAuthType !== 'none') {
    req.session.fhirAuthType         = stored.fhirAuthType;
    req.session.fhirApiKey           = stored.fhirApiKey;
    req.session.fhirBearerToken      = stored.fhirBearerToken;
    req.session.fhirCustomHeaderName = stored.fhirCustomHeaderName;
    req.session.fhirCustomHeaderValue= stored.fhirCustomHeaderValue;
  }
  req.fhirCtx = createFhirContext(req.session);
  next();
});

app.use(demoRoutes);

// In-memory stores
const organizations = [];     // { id, name, fhirServer }
const taskIdentifiers = [];   // { orgId, identifier, taskId, fhirServer }
const initialTasks = [];      // { id, identifier, task, fhirServer }
const authorityTasks = [];    // { id, task, initiatorTaskId, notifications: [], fhirServer }
const subscriptions = [];     // { id, topic, reason, taskIdentifier, notifications: [], fhirServer }
const unknownSubscriptions = [];   // { id, fhirServer, firstSeen, lastNotification }

// Utility: load and fill template
function loadTemplate(file) {
  return JSON.parse(fs.readFileSync(`./templates/${file}`, "utf8"));
}

function fillTemplate(template, replacements) {
  let json = JSON.stringify(template);
  for (const key in replacements) {
    json = json.replace(new RegExp(`{{${key}}}`, "g"), replacements[key]);
  }
  return JSON.parse(json);
}

// Re-hydrate in-memory stores from FHIR server after a reset or restart.
// Called when the user selects an existing Organization during registration.
// Notifications are runtime-only and cannot be recovered; all other state is restored.
async function rehydrateOrgState(orgId, fhirUrl, headers = {}) {
  console.log(`♻️  Re-hydrating state for Organization/${orgId} from ${fhirUrl}`);
  try {
    // ── 1. Submitter Tasks → initialTasks + taskIdentifiers ───────────
    const submitterResp = await axios.get(
      `${fhirUrl}/Task?requester=Organization/${orgId}&_sort=-_lastUpdated`,
      { headers }
    );
    const submitterTasks = (submitterResp.data.entry || []).map(e => e.resource);
    for (const task of submitterTasks) {
      if (initialTasks.find(t => t.id === task.id)) continue;
      const identifier = task.identifier?.[0]?.value || null;
      initialTasks.push({ id: task.id, identifier, task, fhirServer: fhirUrl });
      if (identifier && !taskIdentifiers.find(t => t.taskId === task.id)) {
        taskIdentifiers.push({ orgId, identifier, taskId: task.id, fhirServer: fhirUrl });
      }
    }
    console.log(`  ✅ Recovered ${submitterTasks.length} submitter Task(s)`);

    // ── 2. Authority Tasks → authorityTasks ─────────────────────────────────
    // Query by basedOn referencing each of the submitter's own tasks, so we
    // find authority-created response tasks regardless of who the owner is.
    // This replaces the previous `owner=Organization/${orgId}` query which
    // only found tasks owned by the submitter — not regulator response tasks.
    const submitterTaskIds = submitterTasks.map(t => t.id);
    let authorityTaskList = [];
    for (const submitterTaskId of submitterTaskIds) {
      try {
        const basedOnResp = await axios.get(
          `${fhirUrl}/Task?based-on=Task/${submitterTaskId}&_sort=-_lastUpdated`,
          { headers }
        );
        const found = (basedOnResp.data.entry || []).map(e => e.resource);
        authorityTaskList = authorityTaskList.concat(found);
      } catch (e) {
        console.warn(`  ⚠️  Could not fetch basedOn tasks for Task/${submitterTaskId}:`, e.message);
      }
    }
    for (const task of authorityTaskList) {
      if (authorityTasks.find(t => t.id === task.id)) continue;
      // Use .pop() to handle both relative ("Task/id") and absolute URL references
      const basedOnRef = task.basedOn?.[0]?.reference || "";
      const initiatorTaskId = basedOnRef ? basedOnRef.split("/").pop() : null;
      authorityTasks.push({
        id: task.id,
        task,
        initiatorTaskId,
        notifications: [],  // runtime-only — not recoverable
        fhirServer: fhirUrl
      });
    }
    console.log(`  ✅ Recovered ${authorityTaskList.length} authority Task(s)`);

    // ── 3. Subscriptions ──────────────────────────────────────────────
    // Search by Subscription.identifier.system = "Organization/{orgId}"
    // (managing-entity search parameter is not enabled on this server)
    const subResp = await axios.get(
      `${fhirUrl}/Subscription?identifier=${encodeURIComponent(`Organization/${orgId}`)}|`,
      { headers }
    );
    const subList = (subResp.data.entry || []).map(e => e.resource);
    for (const sub of subList) {
      if (subscriptions.find(s => s.id === sub.id)) continue;
      // taskIdentifier was encoded in the Subscription identifier as:
      // "task-{taskIdentifier}-status-subscription-{uuid}"
      const rawId = sub.identifier?.[0]?.value || "";
      const match = rawId.match(/^task-(.+)-status-subscription-/);
      const taskIdentifier = match ? match[1] : null;
      subscriptions.push({
        id: sub.id,
        topic: sub.topic,
        reason: sub.reason,
        taskIdentifier,
        notifications: [],  // runtime-only — not recoverable
        fhirServer: fhirUrl
      });
    }
    console.log(`  ✅ Recovered ${subList.length} Subscription(s)`);

  } catch (err) {
    // Non-fatal: app continues normally with whatever state was already loaded
    console.error("⚠️  Re-hydration failed (non-fatal):", err.message);
  }
}

//helper to fetch SubscriptionTopics
async function fetchSubscriptionTopics(fhirUrl, headers = {}) {
  const response = await axios.get(`${fhirUrl}/SubscriptionTopic?resource=Task`, {
    headers
  });

  return response.data.entry?.map(e => e.resource) || [];
}

// Home
app.get("/", (req, res) => {
  res.render("index");
});

// POST /reset — wipe all in-memory state and return to initial state
app.post('/reset', (req, res) => {
  organizations.length = 0;
  taskIdentifiers.length = 0;
  initialTasks.length = 0;
  authorityTasks.length = 0;
  subscriptions.length = 0;
  unknownSubscriptions.length = 0;
  resetCredentials();
  req.session.destroy(() => res.redirect('/'));
});

// Register Organization
// GET /register
app.get("/register", (req, res) => {
  const _regStored = getCredentials();
  res.render("register", {
    fhirUrl: _regStored.fhirUrl || "",
    orgName: "",
    orgMatch: null,
    endpointMatch: null,
    fhirAuthType: req.session.fhirAuthType || _regStored.fhirAuthType || "none",
    fhirApiKey: req.session.fhirApiKey || _regStored.fhirApiKey || "",
    fhirBearerToken: req.session.fhirBearerToken || _regStored.fhirBearerToken || "",
    fhirCustomHeaderName: req.session.fhirCustomHeaderName || "",
    fhirCustomHeaderValue: req.session.fhirCustomHeaderValue || ""
  });
});


// POST /register/search-org
app.post("/register/search-org", async (req, res) => {
  const { fhirUrl, orgName, fhirAuthType, fhirApiKey, fhirBearerToken,
    fhirCustomHeaderName, fhirCustomHeaderValue } = req.body;
  req.session.fhirAuthType = fhirAuthType || "none";
  req.session.fhirApiKey = fhirApiKey || "";
  req.session.fhirBearerToken = fhirBearerToken || "";
  req.session.fhirCustomHeaderName = fhirCustomHeaderName || "";
  req.session.fhirCustomHeaderValue = fhirCustomHeaderValue || "";
  const authLocals = {
    fhirAuthType: req.session.fhirAuthType,
    fhirApiKey: req.session.fhirApiKey,
    fhirBearerToken: req.session.fhirBearerToken,
    fhirCustomHeaderName: req.session.fhirCustomHeaderName,
    fhirCustomHeaderValue: req.session.fhirCustomHeaderValue
  };
  // Refresh fhirCtx for THIS request — middleware ran before auth was saved
  req.fhirCtx = createFhirContext(req.session);
  // Persist to process-level store so credentials survive browser close / new tab
  saveCredentials({
    fhirUrl,
    fhirAuthType:          req.session.fhirAuthType,
    fhirApiKey:            req.session.fhirApiKey,
    fhirBearerToken:       req.session.fhirBearerToken,
    fhirCustomHeaderName:  req.session.fhirCustomHeaderName,
    fhirCustomHeaderValue: req.session.fhirCustomHeaderValue
  });
  const trimmedName = (orgName || "").trim();

  function findEndpoint(entries, orgId) {
    return entries.map(e => e.resource).find(ep => {
      const managesOrg = ep.managingOrganization?.reference === `Organization/${orgId}`;
      const codeMatch = Array.isArray(ep.connectionType) &&
        ep.connectionType.some(ct =>
          ct.code === "TEMP-hl7-fhir-subscription-notify" ||
          (Array.isArray(ct.coding) &&
           ct.coding.some(c => c.code === "TEMP-hl7-fhir-subscription-notify"))
        );
      return managesOrg && codeMatch;
    });
  }

  try {
    const orgResp = await axios.get(
      `${fhirUrl}/Organization?name=${encodeURIComponent(trimmedName)}`,
      { headers: req.fhirCtx.headers }
    );

    const allMatches = (orgResp.data.entry || [])
      .map(e => e.resource)
      .filter(o => o.name === trimmedName);

    if (allMatches.length === 0) {
      return res.render("register", {
        fhirUrl,
        orgName: trimmedName,
        orgResults: [],
        ...authLocals
      });
    }

    const orgResults = [];
    for (const candidate of allMatches) {
      const epResp = await axios.get(
        `${fhirUrl}/Endpoint?organization=Organization/${candidate.id}`,
        { headers: req.fhirCtx.headers }
      );
      const entries =
        epResp.data?.resourceType === "Bundle" && Array.isArray(epResp.data.entry)
          ? epResp.data.entry
          : [];
      orgResults.push({ org: candidate, endpoint: findEndpoint(entries, candidate.id) || null });
    }

    res.render("register", {
      fhirUrl,
      orgName: trimmedName,
      orgResults,
      ...authLocals
    });

  } catch (err) {
    console.error(err);
    res.render("error", { message: "Organization lookup failed" });
  }
});


// POST /register/complete
app.post("/register/complete", async (req, res) => {
  const { fhirUrl, mode, orgId, endpointAddress, orgName,
    fhirAuthType, fhirApiKey, fhirBearerToken,
    fhirCustomHeaderName, fhirCustomHeaderValue } = req.body;
  if (fhirAuthType) {
    req.session.fhirAuthType = fhirAuthType;
    req.session.fhirApiKey = fhirApiKey || "";
    req.session.fhirBearerToken = fhirBearerToken || "";
    req.session.fhirCustomHeaderName = fhirCustomHeaderName || "";
    req.session.fhirCustomHeaderValue = fhirCustomHeaderValue || "";
    // Refresh fhirCtx for THIS request — middleware ran before auth was saved
    req.fhirCtx = createFhirContext(req.session);
    // Persist to process-level store so credentials survive browser close
    saveCredentials({
      fhirUrl:               fhirUrl,
      fhirAuthType:          req.session.fhirAuthType,
      fhirApiKey:            req.session.fhirApiKey,
      fhirBearerToken:       req.session.fhirBearerToken,
      fhirCustomHeaderName:  req.session.fhirCustomHeaderName,
      fhirCustomHeaderValue: req.session.fhirCustomHeaderValue
    });
  }
  const trimmedName = (orgName || "").trim();

  // -------------------------------
  // USE EXISTING ORGANIZATION
  // -------------------------------
  if (mode === "use-existing" && orgId) {
    const resolvedName   = (req.body.orgNameByOrg     || {})[orgId] || orgId;
    const resolvedEpId   = (req.body.endpointByOrg    || {})[orgId] || null;

    organizations.push({
      id: orgId,
      name: resolvedName,
      fhirServer: fhirUrl,
      identifier: [{ system: "urn:ietf:rfc:3986", value: orgId }],
      endpointId: resolvedEpId,
      endpointIdentifier: resolvedEpId
        ? [{ system: "urn:ietf:rfc:3986", value: resolvedEpId }]
        : []
    });

    await rehydrateOrgState(orgId, fhirUrl, req.fhirCtx.headers);
    return res.redirect("/submit-task");
  }

  // -------------------------------
  // CREATE NEW ORGANIZATION + ENDPOINT
  // -------------------------------
  if (!fhirUrl || !fhirUrl.startsWith("http")) {
    return res.render("error", { message: "FHIR Server URL is required. Please enter it in the Create New Organization form." });
  }

  const orgUUID = `urn:uuid:${crypto.randomUUID()}`;
  const epUUID = `urn:uuid:${crypto.randomUUID()}`;

  const template = loadTemplate("org-endpoint-bundle.json");
  const bundle = fillTemplate(template, {
    ORG_UUID: orgUUID,
    ORG_NAME: trimmedName,
    ENDPOINT_UUID: epUUID,
    ENDPOINT_ADDRESS: endpointAddress
  });

  try {
    const resp = await axios.post(fhirUrl, bundle, {
      headers: req.fhirCtx.headers
    });

    const orgEntry = (resp.data.entry || []).find(e =>
      e.response?.location?.startsWith("Organization/")
    );
    const endpointEntry = (resp.data.entry || []).find(e =>
      e.response?.location?.startsWith("Endpoint/")
    );

    if (!orgEntry || !endpointEntry) {
      return res.render("error", {
        message: "Registration failed: missing Organization or Endpoint"
      });
    }

    const newOrgId = orgEntry.response.location.split("/")[1];
    const newEndpointId = endpointEntry.response.location.split("/")[1];

    organizations.push({
      id: newOrgId,
      name: trimmedName,
      fhirServer: fhirUrl,
      identifier: [{ system: "urn:ietf:rfc:3986", value: newOrgId }],
      endpointId: newEndpointId,
      endpointIdentifier: [{ system: "urn:ietf:rfc:3986", value: newEndpointId }]
    });

    res.redirect("/submit-task");
  } catch (err) {
    console.error(err);
    res.render("error", { message: "Registration failed" });
  }
});



// Submit Task
app.get("/submit-task", async (req, res) => {
  try {
    const ctdSections = await getCtdSections();

    // Fetch all Organization resources from the FHIR server for owner selection
    let regulatorOrgs = [];
    // baseUrl is not in the session context for the submitter app —
    // use the fhirServer stored on the first registered organization instead.
    const fhirBase = (organizations[0] && organizations[0].fhirServer) || null;
    if (fhirBase) {
      try {
        const orgRes = await fetch(`${fhirBase}/Organization?_count=100`, {
          headers: req.fhirCtx.headers
        });
        if (orgRes.ok) {
          const bundle = await orgRes.json();
          regulatorOrgs = (bundle.entry || []).map(e => ({
            id: e.resource.id,
            name: e.resource.name || e.resource.id
          }));
        }
      } catch (orgErr) {
        console.warn("Could not fetch Organization resources for owner picker:", orgErr.message);
      }
    }

    res.render("submit-task", {
      organizations,
      ctdSections,
      ctdModules,
      regulatorOrgs
    });
  } catch (err) {
    console.error(err);
    res.render("error", { message: "Failed to load CTD sections" });
  }
});

app.post("/submit-task", upload.single("docFile"), async (req, res) => {
  try {
    const FHIR_BASE = req.body.fhirUrl;
    if (!FHIR_BASE) return res.render("error", { message: "Missing FHIR URL" });

    const orgId = req.body.orgId;
    const submitterOrg = organizations.find(o => String(o.id) === String(orgId));
    if (!submitterOrg) {
      return res.render("error", { message: "Submitter organization not found" });
    }

    const taskIdentifier = req.body.taskIdentifier;
    const drugName = req.body.drugName;
    const taskDescription = req.body.taskDescription || "Initial submission";

    // Basic text input (optional)
    const inputs = [];
    if (req.body.textInput && req.body.textInput.trim().length > 0) {
      inputs.push({
        type: {
          coding: [
            {
              system: "http://hl7.org/fhir/uv/apix/CodeSystem/apix-task-input-type",
              code: "text",
              display: "Text Input"
            }
          ]
        },
        valueString: req.body.textInput
      });
    }

    // Optional document -> Binary + DocumentReference + Task.input
    if (req.file) {
      const mimeType = req.file.mimetype || "application/pdf";

      // Binary
      const binResp = await axios.post(
        `${FHIR_BASE}/Binary`,
        req.file.buffer,
        { headers: { ...req.fhirCtx.headers, "Content-Type": mimeType } }
      );
      const binary = binResp.data;

      // CTD section/module from selects
      const [secSystem, secCode, secDisplay] =
        (req.body.docType || "http://example.org/ctd-section|unknown|Unknown").split("|");
      const [modSystem, modCode, modDisplay] =
        (req.body.docCategory || "http://example.org/ctd-module|unknown|Unknown").split("|");

      const now = new Date().toISOString();
      const docBody = {
        resourceType: "DocumentReference",
        status: "current",
        type: {
          coding: [
            {
              system: secSystem,
              code: secCode,
              display: secDisplay
            }
          ]
        },
        category: [
          {
            coding: [
              {
                system: modSystem,
                code: modCode,
                display: modDisplay
              }
            ]
          }
        ],
        description: req.body.docDescription || "",
        author: submitterOrg ? [{ reference: `Organization/${submitterOrg.id}` }] : [],
        date: now,
        subject: {
          display: drugName || "medical product"
        },
        content: [
          {
            attachment: {
              url: `Binary/${binary.id}`,
              contentType: mimeType,
              title: req.file.originalname
            }
          }
        ]
      };

      const docRefResp = await axios.post(
        `${FHIR_BASE}/DocumentReference`,
        docBody,
        { headers: req.fhirCtx.headers }
      );
      const docRef = docRefResp.data;

      inputs.push({
        type: {
			text: secDisplay,   // same display as DocumentReference.type
			coding: [
			  {
			   system: secSystem,
			   code: secCode,
			   display: secDisplay
			  }
		    ]
        },
        valueReference: { reference: `DocumentReference/${docRef.id}` }
      });
    }

    const procUUID = crypto.randomUUID();
    const groupIdentifier = {
      system: `http://${submitterOrg.name.replace(/\s+/g, "-").toLowerCase()}`,
      value: `proc-${procUUID}`
    };

    const body = {
      resourceType: "Task",
      status: "requested",
      intent: "proposal",
      requester: { reference: `Organization/${submitterOrg.id}` },
      for: { display: drugName || "Unknown Product" },
      authoredOn: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      identifier: [
        {
          system: `http://${submitterOrg.name.replace(/\s+/g, "-").toLowerCase()}`,
          value: taskIdentifier
        }
      ],
      code: {
        coding: [
          {
            system: "http://hl7.org/fhir/uv/apix/CodeSystem/apix-task-code",
            code: "initial-submission",
            display: "Initial Submission"
          }
        ],
        text: "Initial Submission"
      },
      description: taskDescription,
      groupIdentifier,
      input: inputs
    };

    // Set Task.owner to the selected Regulator Organization (if provided)
    if (req.body.ownerOrgRef && req.body.ownerOrgRef.trim()) {
      body.owner = { reference: req.body.ownerOrgRef.trim() };
    }

    const resCreate = await fetch(`${FHIR_BASE}/Task`, {
      method: "POST",
      headers: req.fhirCtx.headers,
      body: JSON.stringify(body)
    });
    if (!resCreate.ok) {
      const text = await resCreate.text();
      throw new Error(`FHIR POST Task failed: ${resCreate.status} ${text}`);
    }
    const newTask = await resCreate.json();

    taskIdentifiers.push({ orgId, identifier: taskIdentifier, taskId: newTask.id,  fhirServer: FHIR_BASE });
    initialTasks.push({
      id: newTask.id,
      identifier: taskIdentifier,
      task: newTask,
      fhirServer: FHIR_BASE
    });

    res.redirect(
      `/choose-subscription-topic?taskId=${newTask.id}&orgId=${orgId}&fhirUrl=${encodeURIComponent(
        FHIR_BASE
      )}`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating Submitter Task: " + err.message);
  }
});


app.get("/choose-subscription-topic", async (req, res) => {
  const { fhirUrl, taskId, orgId } = req.query //orgId } = req.query;

  try {
    const topics = await fetchSubscriptionTopics(fhirUrl, req.fhirCtx.headers);

    res.render("choose-subscription-topic", {
      topics,
      taskIdentifiers,
      fhirUrl,
      taskId,
      organizations,
	  orgId
    });

  } catch (err) {
    console.error(err);
    res.render("error", { message: "Failed to load SubscriptionTopics" });
  }
});

app.post("/create-subscription", async (req, res) => {
  const { fhirUrl, topicUrl, taskIdentifier, endpoint, managingEntityRef } = req.body;

  const subscriptionIdentifier =
    `task-${taskIdentifier}-status-subscription-${crypto.randomUUID()}`;

  const template = loadTemplate("subscription.json");

  // Derive org-scoped identifier system from the managing entity reference
  // e.g. "Organization/abc123" → used as Subscription.identifier.system
  // so we can reliably search: Subscription?identifier=Organization/abc123|
  const orgIdSystem = managingEntityRef || "submitterOrgSubscriptions";

  const subscriptionBody = fillTemplate(template, {
    TOPIC_URL: topicUrl,
    TASK_IDENTIFIER: taskIdentifier,
    ENDPOINT: endpoint,
    SUBSCRIPTION_IDENTIFIER: subscriptionIdentifier,
    MANAGING_ENTITY_REF: managingEntityRef,
    ORG_ID_SYSTEM: orgIdSystem
  });

  try {
    const cleanFhirUrl = fhirUrl.replace(/\/+$/, "");
    const response = await axios.post(`${cleanFhirUrl}/Subscription`, subscriptionBody, {
      headers: req.fhirCtx.headers
    });

	const subscription = response.data;
	const subscriptionId = subscription.id;
	const status = subscription.status;

	subscriptions.push({
	  id: subscription.id,
	  topic: subscription.topic,
	  reason: subscription.reason,
	  taskIdentifier,
	  notifications: [],
	  fhirServer: fhirUrl
	});

    res.render("subscription-success", {
     subscriptionId,
     status,
     subscriptionJson: JSON.stringify(subscription, null, 2),
	 fhirUrl
   });

  } catch (err) {
    console.error(err);
    res.render("error", { message: "Subscription creation failed" });
	console.error(err);
  }
});

// Subscription Dashboard
// Live-fetch Subscriptions from FHIR for each registered org (using
// Subscription.identifier.system = "Organization/{orgId}" as the search key),
// then merge with in-memory tracked subscriptions (which carry notification history).
app.get("/subscriptions", async (req, res) => {
  try {
    if (organizations.length > 0 && req.fhirCtx?.baseUrl) {
      for (const org of organizations) {
        const system = encodeURIComponent(`Organization/${org.id}`);
        const url = `${req.fhirCtx.baseUrl}/Subscription?identifier=${system}|`;
        try {
          const resp = await axios.get(url, { headers: req.fhirCtx.headers });
          const liveSubs = (resp.data.entry || []).map(e => e.resource);
          for (const sub of liveSubs) {
            if (subscriptions.find(s => s.id === sub.id)) continue;
            const rawId = sub.identifier?.[0]?.value || "";
            const match = rawId.match(/^task-(.+)-status-subscription-/);
            const taskIdentifier = match ? match[1] : null;
            subscriptions.push({
              id: sub.id,
              topic: sub.topic,
              reason: sub.reason,
              taskIdentifier,
              notifications: [],
              fhirServer: org.fhirServer
            });
          }
        } catch (fetchErr) {
          console.warn(`⚠️  Could not fetch subscriptions for Organization/${org.id}:`, fetchErr.message);
        }
      }
    }
  } catch (err) {
    console.error("⚠️  Subscription live-fetch failed (non-fatal):", err.message);
  }
  res.render("subscription-dashboard", { subscriptions });
});

// app.get("/subscription-status/:id", async (req, res) => {
  // const { id } = req.params;
  // const { fhirUrl } = req.query;

  // try {
    // const response = await axios.get(`${fhirUrl}/Subscription/${id}/$status`, {
      // headers: { "Accept": "application/fhir+json" }
    // });

    // res.json(response.data);

  // } catch (err) {
    // res.status(500).json({ error: "Failed to fetch SubscriptionStatus" });
  // }
// });

app.get("/subscription-status/:id", async (req, res) => {
  const id = req.params.id;
  const fhirUrl = req.query.fhirUrl;

  if (!fhirUrl) {
    return res.status(400).json({ error: "Missing fhirUrl parameter" });
  }

  try {
    // 1. Try the $status operation
    try {
      const statusUrl = `${fhirUrl}/Subscription/${id}/$status`;
      const statusResponse = await axios.get(statusUrl, {
        headers: req.fhirCtx.headers
      });

      if (statusResponse.data) {
        return res.json(statusResponse.data);   // <-- JSON only
      }
    } catch (err) {
      // ignore and fall back
    }

    // 2. Fall back to retrieving the Subscription itself
    const subUrl = `${fhirUrl}/Subscription/${id}`;
    const subResponse = await axios.get(subUrl, {
      headers: req.fhirCtx.headers
    });

    const sub = subResponse.data;

    const derivedStatus = {
      subscriptionId: sub.id,
      status: sub.status || "unknown",
      topic: sub.topic,
      channelType: sub.channel?.type,
      endpoint: sub.channel?.endpoint,
      heartbeatPeriod: sub.channel?.heartbeatPeriod,
      timeout: sub.channel?.timeout,
      lastUpdated: sub.meta?.lastUpdated,
      error: sub.error,
      derived: true
    };

    return res.json(derivedStatus);   // <-- JSON only

  } catch (error) {
    console.error("Error retrieving subscription status:", error);
    return res.status(500).json({
      error: "Unable to retrieve subscription status",
      details: error.response?.data || error.toString()
    });
  }
});

// Notification Receiver
function inferFhirBaseFromTopic(topicUrl) {
  if (!topicUrl) return null;

  const marker = "/SubscriptionTopic/";
  const idx = topicUrl.indexOf(marker);
  if (idx === -1) return null;

  return topicUrl.substring(0, idx);
}

function extractTopicUrl(bundle) {
  const statusEntry = bundle.entry?.find(
    e => e.resource?.resourceType === "SubscriptionStatus"
  );
  return statusEntry?.resource?.topic || null;
}

function getFhirBaseFromNotification(bundle) {
  const topicUrl = extractTopicUrl(bundle);
  const inferred = inferFhirBaseFromTopic(topicUrl);

  if (inferred) {
    //console.log("🔥 Inferred FHIR base from topic:", inferred);
    return inferred;
  }
  //console.log("⚠️ Could not infer FHIR base from topic URL");
  return null;
}

app.post("/fhir-subscription-notify", async (req, res) => {
  const bundle = req.body;
  //console.log('Received FHIR notification:', req.body);
  //console.log('Received FHIR notification method:', req.method);
  //console.log('Received FHIR notification headers:', req.headers);
  // ------------------------------------------------------------
  // FIRST TRY: Validate bundle type
  // ------------------------------------------------------------
  try {
    if (bundle.resourceType !== "Bundle" ||
        bundle.type !== "subscription-notification") {
      //console.log("⚠️ Received non-subscription-notification Bundle", bundle);
      return res.status(200).set("Content-Type", "application/fhir+json").json({ resourceType: "Bundle", type: "transaction-response", entry: [] });   // STOP PROCESSING
    }
  } catch (err) {
    console.error("❌ Error validating bundle type:", err);
    return res.status(200).set("Content-Type", "application/fhir+json").json({ resourceType: "Bundle", type: "transaction-response", entry: [] });     // Still return 200
  }

  // ------------------------------------------------------------
  // SECOND TRY: Process subscription-notification
  // ------------------------------------------------------------
  try {
    // Extract SubscriptionStatus
    const statusEntry = bundle.entry?.find(
      e => e.resource?.resourceType === "SubscriptionStatus"
    );

    if (!statusEntry) {
      //console.log("❌ 405: Missing SubscriptionStatus in notification");
      return res.status(405).json({ error: "Missing SubscriptionStatus" });
    }

    const subStatus = statusEntry.resource;
    const type = subStatus.type;

    // ------------------------------------------------------------
    // If NOT event-notification → log + 200 + STOP
    // ------------------------------------------------------------
    if (type !== "event-notification") {
      //console.log(`ℹ️ Received ${type} notification for subscription ${subStatus.subscription?.reference}`);
      return res.status(200).set("Content-Type", "application/fhir+json").json({ resourceType: "Bundle", type: "transaction-response", entry: [] });
    }

    // ------------------------------------------------------------
    // EVENT-NOTIFICATION PROCESSING
    // ------------------------------------------------------------

    // Extract subscription ID
    const subscriptionRef = subStatus.subscription?.reference;
    const subscriptionId = subscriptionRef?.split("/")[1];

    if (!subscriptionId) {
      //console.log("❌ 405: Missing subscription reference");
      return res.status(405).json({ error: "Missing subscription reference" });
    }

    // Extract Task reference
    const event = subStatus.notificationEvent?.[0];
    const taskRef = event?.focus?.reference;
    const taskId = taskRef?.split("/")[1];

    if (!taskId) {
      //console.log("❌ 405: Missing Task reference in notification");
      return res.status(405).json({ error: "Missing Task reference" });
    }

    // Extract Task resource (if included)
    let taskResource = bundle.entry?.find(
      e => e.resource?.resourceType === "Task"
    )?.resource;

    // Retrieve Task if missing
    if (!taskResource) {
      try {
        // const fhirServer = req.headers["x-fhir-base"] || null;
		// cannot guarentee that x-fhir-base is used, so we infer from cononcial instead 
		const fhirServer = getFhirBaseFromNotification(bundle);

        if (fhirServer) {
          const taskResponse = await axios.get(`${fhirServer}/Task/${taskId}`, {
            headers: getCachedFhirHeaders()
          });
          taskResource = taskResponse.data;
          //console.log(`📥 Retrieved Task ${taskId} from FHIR server`);
        } else {
          console.log(`⚠️ No Task in notification and could not infer from SubscriptionTopic canonical; cannot retrieve Task ${taskId}`);
        }
      } catch (err) {
        console.error(`❌ Failed to retrieve Task ${taskId}:`, err);
      }
    }

    // ------------------------------------------------------------
    // MEMORY UPDATES (unchanged)
    // ------------------------------------------------------------

    // Update subscription tracking
    let sub = subscriptions.find(s => s.id === subscriptionId);

    if (sub) {
      sub.notifications.push({
        date: new Date().toISOString(),
        payload: bundle,
        taskStatus: taskResource?.status || "unknown",
        fhirServer: req.headers["x-fhir-base"] || null
      });
    } else {
      //console.log(`ℹ️ Subscription ${subscriptionId} not known — cataloging only.`);

      let unknown = unknownSubscriptions.find(u => u.id === subscriptionId);

      if (!unknown) {
        unknownSubscriptions.push({
          id: subscriptionId,
          fhirServer: req.headers["x-fhir-base"] || null,
          firstSeen: new Date().toISOString(),
          lastNotification: new Date().toISOString()
        });
        //console.log(`📥 Captured unknown Subscription ${subscriptionId}`);
      } else {
        unknown.lastNotification = new Date().toISOString();
        //console.log(`📨 Logging unknown Subscription ${subscriptionId} (new notification)`);
      }
    }

    // Replace stored Task Resource (initial + authority)
    if (taskResource) {
      let init = initialTasks.find(t => t.id === taskId);
      if (init) {
        //console.log(`🔄 Updating stored initial Task ${taskId}`);
        init.task = taskResource;
      }

      let auth = authorityTasks.find(t => t.id === taskId);
      if (auth) {
        //console.log(`🔄 Updating stored authority Task ${taskId}`);
        auth.task = taskResource;
      }
    }

    // Authority Task handling
    if (taskResource) {
		
      const basedOnRef = taskResource.basedOn?.[0]?.reference || "";
      // Use .pop() to handle both relative ("Task/id") and absolute URL references
      const initiatorTaskId = basedOnRef ? basedOnRef.split("/").pop() : null;

      const isAuthorityTask =
        taskResource.owner?.reference &&
        organizations.some(org => taskResource.owner.reference.includes(org.id));

      if (isAuthorityTask) {
        let existing = authorityTasks.find(t => t.id === taskId);

        if (!existing) {
		 const fhirServer = req.headers["x-fhir-base"] || getFhirBaseFromNotification(bundle);
          authorityTasks.push({
            id: taskId,
            task: taskResource,
            initiatorTaskId: initiatorTaskId || null,
            notifications: [],
            fhirServer: fhirServer
          });
          existing = authorityTasks[authorityTasks.length - 1];
        }

        existing.notifications.push({
          date: new Date().toISOString(),
          payload: bundle,
          fhirServer: req.headers["x-fhir-base"] || null
        });
      }

      // Hydrate missing initial tasks
      if (initiatorTaskId) {
        let initParent = initialTasks.find(t => t.id === initiatorTaskId);

        if (initParent && !initParent.task) {
          //console.log(`🩺 Hydrating missing initial Task ${initiatorTaskId}`);
          initParent.task = taskResource;
        }

        if (!initParent) {
          //console.log(`🆕 Creating initial Task ${initiatorTaskId}`);
          initialTasks.push({
            id: initiatorTaskId,
            identifier: taskResource.identifier?.[0]?.value || null,
            task: taskResource,
            fhirServer: req.headers["x-fhir-base"] || null
          });
        }
      }
    }

    // ------------------------------------------------------------
    // Successful event-notification → return 200
    // ------------------------------------------------------------
    return res.status(200).set("Content-Type", "application/fhir+json").json({ resourceType: "Bundle", type: "transaction-response", entry: [] });

  } catch (err) {
    console.error("❌ Unexpected error in subscription-notification handler:", err);
    return res.status(200).set("Content-Type", "application/fhir+json").json({ resourceType: "Bundle", type: "transaction-response", entry: [] });
  }
});

// Authority Tasks Dashboard
app.get("/authority-tasks", (req, res) => {
  res.render("authority-tasks", { authorityTasks });
});

// Authority Task Detail
app.get("/authority-task/:id", async (req, res) => {
  const task = authorityTasks.find(t => t.id === req.params.id);
  if (!task) return res.render("error", { message: "Authority Task not found" });
  const ctdSections = await getCtdSections();
  res.render("authority-task-detail", { task, ctdSections, ctdModules });
});


// Add output to Authority Task (document upload or text)
// Path 2 of the authority task response flow (no Questionnaire).
// File → Binary → DocumentReference (CTD type/category) → Task.output valueReference
// Text → Task.output valueString
app.post("/authority-task/:id/add-output", upload.single("docFile"), async (req, res) => {
  const taskId = req.params.id;
  const entry = authorityTasks.find(t => t.id === taskId);
  if (!entry) return res.render("error", { message: "Authority Task not found" });

  const fhirServer = entry.fhirServer;
  const task = JSON.parse(JSON.stringify(entry.task)); // deep clone
  task.output = task.output || [];

  try {
    // ── Document upload path ─────────────────────────────────────
    if (req.file) {
      const mimeType = req.file.mimetype || "application/pdf";

      // 1. POST Binary
      const binResp = await axios.post(
        `${fhirServer}/Binary`,
        req.file.buffer,
        { headers: { ...req.fhirCtx.headers, "Content-Type": mimeType } }
      );
      const binary = binResp.data;

      // 2. Parse CTD section (type) and module (category) from pipe-delimited values
      const [secSystem, secCode, secDisplay] =
        (req.body.docType || "http://example.org/ctd-section|unknown|Unknown").split("|");
      const [modSystem, modCode, modDisplay] =
        (req.body.docCategory || "http://example.org/ctd-module|unknown|Unknown").split("|");

      const now = new Date().toISOString();

      // 3. POST DocumentReference
      const docBody = {
        resourceType: "DocumentReference",
        status: "current",
        type: {
          coding: [{ system: secSystem, code: secCode, display: secDisplay }],
          text: secDisplay
        },
        category: [
          { coding: [{ system: modSystem, code: modCode, display: modDisplay }] }
        ],
        description: req.body.docDescription || "",
        author: task.owner?.reference ? [{ reference: task.owner.reference }] : [],
        date: now,
        subject: { display: "Authority Task response document" },
        content: [{
          attachment: {
            url: `Binary/${binary.id}`,
            contentType: mimeType,
            title: req.file.originalname,
            creation: now
          }
        }]
      };

      const docRefResp = await axios.post(
        `${fhirServer}/DocumentReference`,
        docBody,
        { headers: req.fhirCtx.headers }
      );
      const docRef = docRefResp.data;

      task.output.push({
        type: {
          coding: [{ system: secSystem, code: secCode, display: secDisplay }],
          text: secDisplay
        },
        valueReference: { reference: `DocumentReference/${docRef.id}` }
      });
    }

    // ── Optional text output ─────────────────────────────────────
    const outputText = (req.body.outputText || "").trim();
    if (outputText) {
      task.output.push({
        type: { text: "Submitter note" },
        valueString: outputText
      });
    }

    if (!req.file && !outputText) {
      return res.render("error", { message: "Please attach a document or enter a note." });
    }

    // 4. PUT updated Task
    const updateResp = await axios.put(
      `${fhirServer}/Task/${taskId}`,
      task,
      { headers: req.fhirCtx.headers }
    );
    entry.task = updateResp.data;

    res.redirect(`/authority-task/${taskId}`);

  } catch (err) {
    console.error("add-output error:", err);
    res.render("error", { message: "Failed to add output: " + err.message });
  }
});

// Complete Authority Task
app.post("/authority-task/:id/complete", async (req, res) => {
  const { fhirUrl, blurb } = req.body;
  const taskId = req.params.id;

  const entry = authorityTasks.find(t => t.id === taskId);
  const task = JSON.parse(JSON.stringify(entry.task)); // deep clone

  // Update Task fields
  task.status = "completed";

  // Append a completion note only if the submitter entered one.
  // Document outputs are added separately via /add-output before completing.
  if (blurb && blurb.trim()) {
    task.output = task.output || [];
    task.output.push({
      type: { text: "Submitter completion note" },
      valueString: blurb.trim()
    });
  }

  try {
    const response = await axios.put(
      `${fhirUrl}/Task/${taskId}`,
      task,
      { headers: req.fhirCtx.headers }
    );

    // Update local copy
    entry.task = response.data;

    res.render("authority-task-completed", {
      taskId,
      status: response.data.status,
      fhirServer: fhirUrl
    });

  } catch (err) {
    res.render("error", { message: "Failed to update Task" });
  }
});



// GET /authority-task/:id/answer-questionnaire
// Receives ?docRefId={id} — the DocumentReference that wraps the Questionnaire.
// Fetches the DocumentReference, extracts content[0].attachment.url as the
// Questionnaire reference, then fetches the Questionnaire and renders the form.
app.get("/authority-task/:id/answer-questionnaire", async (req, res) => {
  const { docRefId } = req.query;
  const taskId = req.params.id;

  const entry = authorityTasks.find(t => t.id === taskId);
  if (!entry) return res.render("error", { message: "Task not found" });

  const fhirServer = entry.fhirServer;

  function resolveQuestionnaireUrl(fhirServer, ref) {
    if (!ref) return null;
    if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
    return `${fhirServer}/${ref}`;
  }

  try {
    if (!docRefId) return res.render("error", { message: "Missing DocumentReference ID" });

    // Step 1: fetch the DocumentReference that wraps the Questionnaire
    const docRefResp = await axios.get(`${fhirServer}/DocumentReference/${docRefId}`, {
      headers: req.fhirCtx.headers
    });
    const questionnaireRef = docRefResp.data?.content?.[0]?.attachment?.url;
    if (!questionnaireRef) {
      return res.render("error", { message: "DocumentReference does not contain a Questionnaire URL" });
    }

    // Step 2: resolve and fetch the Questionnaire itself
    const url = resolveQuestionnaireUrl(fhirServer, questionnaireRef);
    if (!url) return res.render("error", { message: "Invalid Questionnaire reference" });

    const qResponse = await axios.get(url, {
      headers: req.fhirCtx.headers
    });

    res.render("questionnaire-answer", {
      taskId,
      questionnaire: qResponse.data,
      fhirServer,
      questionnaireRef
    });

  } catch (err) {
    console.error(err);
    res.render("error", { message: "Failed to load Questionnaire" });
  }
});

// POST /authority-task/:id/submit-questionnaire
app.post("/authority-task/:id/submit-questionnaire", async (req, res) => {
  const taskId = req.params.id;
  const { questionnaireUrl, fhirServer } = req.body;

  const entry = authorityTasks.find(t => t.id === taskId);
  if (!entry) return res.render("error", { message: "Task not found" });
  if (!fhirServer) return res.render("error", { message: "Missing FHIR server URL" });

  const task = JSON.parse(JSON.stringify(entry.task));

  const submitterOrgRef = task.owner?.reference;
  const submitterOrg = await axios
    .get(`${fhirServer}/${submitterOrgRef}`, {
      headers: req.fhirCtx.headers
    })
    .then(r => r.data);

  const containedOrg = {
    resourceType: "Organization",
    id: "submitter-org",
    name: submitterOrg.name,
    identifier: submitterOrg.identifier || []
  };

  const qr = {
    resourceType: "QuestionnaireResponse",
    questionnaire: questionnaireUrl,
    status: "completed",
    authored: new Date().toISOString(),
	contained: [containedOrg],
    source: { reference: "#submitter-org" },
    author: { reference: task.requester.reference },
    item: []
  };

  Object.keys(req.body)
    .filter(k => k.startsWith("q_"))
    .forEach(k => {
      const linkId = k.replace("q_", "");
      const raw = req.body[k];
      if (!raw) return;
	  
	  const qDef = req.body[`qtext_${linkId}`];
	  //console.log("what is here ",linkId, " and ",qDef);

      const answer = {};

      if (raw.includes("|")) {
        const [code, display] = raw.split("|");
        answer.valueCoding = { code, display };
      } else if (!isNaN(raw) && raw.trim() !== "") {
        answer.valueInteger = parseInt(raw, 10);
      } else if (raw === "true" || raw === "false") {
        answer.valueBoolean = raw === "true";
      } else if (raw.match(/^\d{4}-\d{2}-\d{2}$/)) {
        answer.valueDate = raw;
      } else {
        answer.valueString = raw;
      }

	  const itemBlock = { linkId, answer: [answer] };
	  if (qDef) {
	    itemBlock.text = qDef;
	  }
	  qr.item.push(itemBlock);

    });

  try {
    const qrCreate = await axios.post(
      `${fhirServer}/QuestionnaireResponse`,
      qr,
      { headers: req.fhirCtx.headers }
    );

    const savedQr = qrCreate.data;

    // Wrap QuestionnaireResponse in a DocumentReference → Task.output
    const CTD_CS = "http://hl7.org/fhir/uv/apix/CodeSystem/ctd-section";
    const qrDocRefBody = {
      resourceType: "DocumentReference",
      status: "current",
      type: { coding: [{ system: CTD_CS, code: "applicant-questionnaireResponse", display: "Applicant QuestionnaireResponse" }] },
      category: [{ coding: [{ system: CTD_CS, code: "m1", display: "Module 1" }] }],
      author: task.owner?.reference ? [{ reference: task.owner.reference }] : [],
      date: new Date().toISOString(),
      content: [{ attachment: { url: `QuestionnaireResponse/${savedQr.id}`, contentType: "application/fhir+json" } }]
    };
    const qrDocRefResp = await axios.post(
      `${fhirServer}/DocumentReference`,
      qrDocRefBody,
      { headers: req.fhirCtx.headers }
    );
    const qrDocRef = qrDocRefResp.data;

    task.output = task.output || [];
    task.output.push({
      type: { coding: [{ system: CTD_CS, code: "applicant-questionnaireResponse", display: "Applicant QuestionnaireResponse" }] },
      valueReference: { reference: `DocumentReference/${qrDocRef.id}` }
    });

    const taskUpdate = await axios.put(
      `${fhirServer}/Task/${taskId}`,
      task,
      { headers: req.fhirCtx.headers }
    );

    entry.task = taskUpdate.data;
    res.redirect(`/authority-task/${taskId}`);

  } catch (err) {
    console.error(err);
    res.render("error", { message: "Failed to submit QuestionnaireResponse" });
  }
});

// POST /initial-task/:id/withdraw
app.post("/initial-task/:id/withdraw", async (req, res) => {
  const taskId = req.params.id;
  const { statusReason } = req.body;

  const entry = initialTasks.find(t => t.id === taskId);
  if (!entry) return res.status(404).render("error", { message: "Task not found" });

  const task = JSON.parse(JSON.stringify(entry.task)); // deep clone
  task.status = "cancelled";
  task.businessStatus = {
    coding: [{ system: "http://hl7.org/fhir/uv/apix/CodeSystem/apix-business-status", code: "withdrawn", display: "Withdrawn" }]
  };
  if (statusReason && statusReason.trim()) {
    task.statusReason = { concept: { text: statusReason.trim() } };
  }

  try {
    const response = await axios.put(
      `${entry.fhirServer}/Task/${taskId}`,
      task,
      { headers: req.fhirCtx.headers }
    );
    entry.task = response.data;
    res.redirect("/related-tasks");
  } catch (err) {
    res.render("error", { message: "Failed to withdraw Task" });
  }
});

// Related Tasks View
// Live-fetches authority (basedOn) Tasks from FHIR for each initial task,
// merges with in-memory authorityTasks (which carry notification history),
// then renders. Robust after resets or missed notifications.
app.get("/related-tasks", async (req, res) => {
  // Attempt live fetch if we have a FHIR base available
  const fhirBase = req.fhirCtx?.baseUrl;
  if (fhirBase && initialTasks.length > 0) {
    for (const init of initialTasks) {
      try {
        const resp = await axios.get(
          `${fhirBase}/Task?based-on=Task/${init.id}&_sort=-_lastUpdated`,
          { headers: req.fhirCtx.headers }
        );
        const liveTasks = (resp.data.entry || []).map(e => e.resource);
        for (const task of liveTasks) {
          if (authorityTasks.find(t => t.id === task.id)) continue;
          const basedOnRef = task.basedOn?.[0]?.reference || "";
          const initiatorTaskId = basedOnRef ? basedOnRef.split("/").pop() : null;
          authorityTasks.push({
            id: task.id,
            task,
            initiatorTaskId,
            notifications: [],
            fhirServer: init.fhirServer
          });
          console.log(`ℹ️  Related-tasks: live-loaded authority Task/${task.id} (basedOn Task/${init.id})`);
        }
      } catch (err) {
        console.warn(`⚠️  Could not fetch basedOn tasks for Task/${init.id}:`, err.message);
      }
    }
  }

  // Build the linked structure
  const related = initialTasks.map(init => {
    const linked = authorityTasks.filter(a => a.initiatorTaskId === init.id);
    return {
      initial: init,
      authority: linked
    };
  });

  res.render("related-tasks", { related });
});
// ─────────────────────────────────────────────────────────────
// DocumentReference Viewer
// ─────────────────────────────────────────────────────────────
// Drop these two routes into server.js immediately before the
// app.listen() call. No other changes to server.js are needed.
// ─────────────────────────────────────────────────────────────

// GET /documents/:id
// Fetches the DocumentReference, resolves linked Tasks from the
// in-memory stores, and renders the document-viewer view.
// The Binary is NOT fetched here.
app.get("/documents/:id", async (req, res) => {
  const docId   = req.params.id;
  const fhirBase = req.query.fhirUrl || "";

  // ── Resolve FHIR base URL ──────────────────────────────────
  // Prefer ?fhirUrl query param. Fall back to fhirServer from
  // any Task in memory that references this DocumentReference.
  function resolveFhirBase(docRefId) {
    if (fhirBase) return fhirBase;

    const ref = `DocumentReference/${docRefId}`;

    for (const t of initialTasks) {
      const inInput  = (t.task?.input  || []).some(i => i.valueReference?.reference === ref);
      const inOutput = (t.task?.output || []).some(o => o.valueReference?.reference === ref);
      if ((inInput || inOutput) && t.fhirServer) return t.fhirServer;
    }

    for (const t of authorityTasks) {
      const inInput  = (t.task?.input  || []).some(i => i.valueReference?.reference === ref);
      const inOutput = (t.task?.output || []).some(o => o.valueReference?.reference === ref);
      if ((inInput || inOutput) && t.fhirServer) return t.fhirServer;
    }

    return null;
  }

  const resolvedFhirBase = resolveFhirBase(docId);

  if (!resolvedFhirBase) {
    return res.render("error", {
      message:
        `Cannot load DocumentReference/${docId}: ` +
        `no FHIR server URL is known. ` +
        `Append ?fhirUrl=https://your-server.org/fhir to the URL.`
    });
  }

  // ── Fetch DocumentReference ────────────────────────────────
  let docRef;
  try {
    const drResp = await axios.get(
      `${resolvedFhirBase}/DocumentReference/${docId}`,
      { headers: req.fhirCtx.headers }
    );
    docRef = drResp.data;
  } catch (err) {
    return res.render("error", {
      message: `DocumentReference/${docId} not found on FHIR server: ${err.message}`
    });
  }

  // ── Extract Binary ID (without fetching the Binary) ────────
  // The app stores the attachment URL as "Binary/<id>" (relative).
  // We just extract the id from that string.
  const attachmentUrl = docRef.content?.[0]?.attachment?.url || "";
  let binaryId = null;
  if (attachmentUrl.startsWith("Binary/")) {
    binaryId = attachmentUrl.replace("Binary/", "");
  } else if (attachmentUrl.match(/\/Binary\/([^/]+)$/)) {
    binaryId = attachmentUrl.match(/\/Binary\/([^/]+)$/)[1];
  }

  // ── Find linked Tasks in memory ────────────────────────────
  // Search both initialTasks and authorityTasks for any Task
  // whose input or output references this DocumentReference.
  const ref = `DocumentReference/${docId}`;
  const linkedTasks = [];

  for (const t of initialTasks) {
    if (!t.task) continue;
    const inInput  = (t.task.input  || []).some(i => i.valueReference?.reference === ref);
    const inOutput = (t.task.output || []).some(o => o.valueReference?.reference === ref);
    if (inInput)  linkedTasks.push({ task: t.task, via: "input",  store: "initial" });
    if (inOutput) linkedTasks.push({ task: t.task, via: "output", store: "initial" });
  }

  for (const t of authorityTasks) {
    if (!t.task) continue;
    const inInput  = (t.task.input  || []).some(i => i.valueReference?.reference === ref);
    const inOutput = (t.task.output || []).some(o => o.valueReference?.reference === ref);
    if (inInput)  linkedTasks.push({ task: t.task, via: "input",  store: "authority" });
    if (inOutput) linkedTasks.push({ task: t.task, via: "output", store: "authority" });
  }

  res.render("document-viewer", {
    docRef,
    binaryId,
    linkedTasks,
    fhirBase: resolvedFhirBase,
    pageTitle: `DocumentReference/${docId}`
  });
});


// GET /documents/:id/binary
// Streams the Binary from the FHIR server to the browser.
// Called only when the user explicitly clicks "View PDF" or "Download PDF".
// The Binary is NOT fetched by any other route.
app.get("/documents/:id/binary", async (req, res) => {
  const docId    = req.params.id;
  const download = req.query.download === "1";
  const fhirBase = req.query.fhirUrl || "";

  // ── Resolve FHIR base and Binary ID ───────────────────────
  // We must fetch the DocumentReference first to get the Binary ID.
  // This is the only fetch that happens before streaming.
  function resolveFhirBase(docRefId) {
    if (fhirBase) return fhirBase;
    const ref = `DocumentReference/${docRefId}`;
    for (const t of [...initialTasks, ...authorityTasks]) {
      const inInput  = (t.task?.input  || []).some(i => i.valueReference?.reference === ref);
      const inOutput = (t.task?.output || []).some(o => o.valueReference?.reference === ref);
      if ((inInput || inOutput) && t.fhirServer) return t.fhirServer;
    }
    return null;
  }

  const resolvedFhirBase = resolveFhirBase(docId);

  if (!resolvedFhirBase) {
    return res.status(400).send(
      `Cannot stream Binary for DocumentReference/${docId}: ` +
      `no FHIR server URL known. Append ?fhirUrl=... to the URL.`
    );
  }

  // ── Fetch DocumentReference to get the Binary URL ─────────
  let docRef;
  try {
    const drResp = await axios.get(
      `${resolvedFhirBase}/DocumentReference/${docId}`,
      { headers: req.fhirCtx.headers }
    );
    docRef = drResp.data;
  } catch (err) {
    return res.status(404).send(`DocumentReference/${docId} not found: ${err.message}`);
  }

  const attachmentUrl = docRef.content?.[0]?.attachment?.url || "";
  const contentType   = docRef.content?.[0]?.attachment?.contentType || "application/octet-stream";
  const title         = docRef.content?.[0]?.attachment?.title || `document-${docId}.pdf`;

  // Build the full Binary URL
  let binaryUrl;
  if (attachmentUrl.startsWith("http://") || attachmentUrl.startsWith("https://")) {
    binaryUrl = attachmentUrl;
  } else if (attachmentUrl.startsWith("Binary/")) {
    binaryUrl = `${resolvedFhirBase}/${attachmentUrl}`;
  } else {
    return res.status(404).send("No Binary attachment URL found in DocumentReference.");
  }

  // ── Fetch Binary and handle both raw-bytes and FHIR-JSON wrapper ──
  // HAPI FHIR may return either:
  //   (a) raw PDF bytes  — Content-Type: application/pdf
  //   (b) Binary resource as JSON — Content-Type: application/fhir+json
  //       with the actual bytes base64-encoded in resource.data
  // We use arraybuffer so we can inspect the response before sending.
  try {
    const binaryResp = await axios.get(binaryUrl, {
      responseType: "arraybuffer",
      headers: {
        ...req.fhirCtx.headers,
        // Ask for raw PDF first; server may still return FHIR JSON
        Accept: "application/pdf, application/octet-stream, application/fhir+json, */*"
      }
    });

    const respContentType = (binaryResp.headers["content-type"] || "").toLowerCase();
    let pdfBuffer;
    let finalContentType = contentType || "application/pdf";

    if (respContentType.includes("fhir+json") || respContentType.includes("application/json")) {
      // Server returned the Binary resource wrapper — decode base64 data field
      let binaryResource;
      try {
        binaryResource = JSON.parse(Buffer.from(binaryResp.data).toString("utf8"));
      } catch (parseErr) {
        return res.status(500).send("Binary fetch returned JSON but could not be parsed.");
      }
      if (!binaryResource.data) {
        return res.status(500).send(
          `Binary resource returned but contained no 'data' field. ` +
          `resourceType=${binaryResource.resourceType}, contentType=${binaryResource.contentType}`
        );
      }
      pdfBuffer      = Buffer.from(binaryResource.data, "base64");
      finalContentType = binaryResource.contentType || "application/pdf";
      console.log(`ℹ️  Binary/${docId}: received FHIR JSON wrapper — decoded ${pdfBuffer.length} bytes`);
    } else {
      // Server returned raw bytes directly
      pdfBuffer = Buffer.from(binaryResp.data);
      console.log(`ℹ️  Binary/${docId}: received raw bytes — ${pdfBuffer.length} bytes`);
    }

    // Ensure we always tell the browser this is a PDF
    if (!finalContentType || finalContentType === "application/octet-stream") {
      finalContentType = "application/pdf";
    }

    const disposition = download
      ? `attachment; filename="${title.replace(/"/g, "'")}"`
      : `inline; filename="${title.replace(/"/g, "'")}"`; 

    res.setHeader("Content-Type", finalContentType);
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (err) {
    res.status(500).send(`Failed to fetch Binary: ${err.message}`);
  }
});
// ─────────────────────────────────────────────────────────────────
// Submitter Annual Reporting Dashboard — Drop-in route block
// ─────────────────────────────────────────────────────────────────
// Paste this block into server.js immediately before app.listen().
// No other changes to server.js are required.
//
// Adds one new route:
//   GET /submitter/annual-report
//
// Uses the existing in-memory stores:
//   initialTasks     – tasks submitted by the company
//   authorityTasks   – authority-created tasks (questions, decisions)
//   organizations    – registered submitter organizations
//
// No new npm dependencies. No existing routes modified.
// ─────────────────────────────────────────────────────────────────

app.get("/submitter/annual-report", async (req, res) => {
  const fhirUrl = (req.query.fhirUrl || "").replace(/\/+$/, "");

  // ── Optional: fetch fresh Tasks from FHIR server ─────────────
  // Falls back to in-memory stores if no fhirUrl is provided or
  // if the fetch fails. This keeps the dashboard useful even in
  // offline / demo mode.
  let fetchedTasks = [];
  let fetchError   = null;

  if (fhirUrl) {
    try {
      // Fetch all Tasks authored by any registered organization
      // (submitter-side: requester = our org)
      const r = await axios.get(
        `${fhirUrl}/Task?_count=500&_sort=-_lastUpdated`,
        { headers: req.fhirCtx.headers }
      );
      fetchedTasks = (r.data.entry || []).map(e => e.resource).filter(Boolean);
    } catch (err) {
      fetchError = err.message;
    }
  }

  // ── Build the working task list ───────────────────────────────
  // Merge: prefer fresh FHIR data when available; otherwise use
  // in-memory initialTasks + authorityTasks.
  const allTasks = fetchedTasks.length > 0
    ? fetchedTasks
    : [
        ...initialTasks.map(t => t.task).filter(Boolean),
        ...authorityTasks.map(t => t.task).filter(Boolean),
      ];

  // ── APIX businessStatus → submitter workflow stage ───────────
  // From the IG: submitter sees their own journey from submission
  // through authority decision.
  const SUBMITTER_STAGE = {
    "submitted":               { stage: 1, label: "Submitted",              submitterAction: false },
    "validation-in-progress":  { stage: 2, label: "Validation in Progress", submitterAction: false },
    "validation-passed":       { stage: 2, label: "Validation Passed",      submitterAction: false },
    "validation-failed":       { stage: 2, label: "Validation Failed",      submitterAction: true  },
    "under-assessment":        { stage: 3, label: "Under Assessment",       submitterAction: false },
    "questions-raised":        { stage: 3, label: "Questions Raised",       submitterAction: true  },
    "clock-stop":              { stage: 4, label: "Clock Stop",             submitterAction: true  },
    "awaiting-response":       { stage: 4, label: "Awaiting Response",      submitterAction: true  },
    "response-received":       { stage: 5, label: "Response Received",      submitterAction: false },
    "assessment-resumed":      { stage: 5, label: "Assessment Resumed",     submitterAction: false },
    "approved":                { stage: 6, label: "Approved",               submitterAction: false },
    "rejected":                { stage: 6, label: "Rejected",               submitterAction: false },
    "withdrawn":               { stage: 6, label: "Withdrawn",              submitterAction: false },
  };

  const APIX_TASK_CS = "http://hl7.org/fhir/uv/apix/CodeSystem/apix-task-code";
  const APIX_BIZ_CS  = "http://hl7.org/fhir/uv/apix/CodeSystem/apix-business-status";
  const CTD_CS       = "http://hl7.org/fhir/uv/apix/CodeSystem/ctd-section";

  // Submission-type task codes (company-initiated)
  const SUBMITTER_CODES = new Set([
    "initial-submission", "supplement", "variation-type-ib",
    "response-to-questions", "withdrawal", "annual-report",
  ]);

  // Authority-initiated codes (the company must respond to these)
  const AUTHORITY_CODES = new Set([
    "information-request", "validation-report", "approval",
    "rejection", "request-payment",
  ]);

  // ── Compute all metrics ───────────────────────────────────────

  // 1. Categorise tasks
  const submitterTasks = [];   // tasks initiated by the submitter
  const authorityQTasks = [];  // tasks the authority sent TO the submitter
  const decisionTasks  = [];   // final-decision tasks

  for (const t of allTasks) {
    const code = t.code?.coding?.find(c => c.system === APIX_TASK_CS)?.code
              || t.code?.coding?.[0]?.code || "";
    const biz  = t.businessStatus?.coding?.[0]?.code || "";

    if (SUBMITTER_CODES.has(code))  submitterTasks.push(t);
    if (AUTHORITY_CODES.has(code))  authorityQTasks.push(t);
    if (["approved","rejected","withdrawn"].includes(biz)) decisionTasks.push(t);
  }

  // 2. Submission volume by Task code
  const byCode = {};
  for (const t of submitterTasks) {
    const code = t.code?.coding?.find(c => c.system === APIX_TASK_CS)?.code
              || t.code?.coding?.[0]?.code || "unknown";
    byCode[code] = (byCode[code] || 0) + 1;
  }

  // 3. businessStatus distribution (all tasks)
  const byBizStatus = {};
  for (const t of allTasks) {
    const biz  = t.businessStatus?.coding?.[0]?.display
              || t.businessStatus?.coding?.[0]?.code || "Unknown";
    byBizStatus[biz] = (byBizStatus[biz] || 0) + 1;
  }

  // 4. Workflow stage distribution
  const byStage = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const t of allTasks) {
    const biz = t.businessStatus?.coding?.[0]?.code || "";
    const info = SUBMITTER_STAGE[biz];
    if (info) byStage[info.stage] = (byStage[info.stage] || 0) + 1;
  }

  // 5. Tasks requiring submitter action right now
  const awaitingSubmitter = allTasks.filter(t => {
    const biz = t.businessStatus?.coding?.[0]?.code || "";
    return SUBMITTER_STAGE[biz]?.submitterAction === true;
  });

  // 6. FHIR task.status distribution
  const byFhirStatus = {};
  for (const t of allTasks) {
    const s = t.status || "unknown";
    byFhirStatus[s] = (byFhirStatus[s] || 0) + 1;
  }

  // 7. CTD modules referenced in Task inputs
  const byModule = {};
  for (const t of allTasks) {
    for (const inp of (t.input || [])) {
      const code = inp.type?.coding?.[0]?.code || "";
      const mod  = code.split(".")[0];
      if (/^[1-5]$/.test(mod)) {
        const key = `Module ${mod}`;
        byModule[key] = (byModule[key] || 0) + 1;
      }
    }
  }

  // 8. Timeliness metrics (days)
  let totalSubmitToDecision = 0,  countDecision = 0;
  let totalQuestionToResponse = 0, countQR = 0;
  let totalSubmitToAccept = 0,    countAccept = 0;
  const durations = []; // for histogram

  for (const t of allTasks) {
    if (!t.authoredOn) continue;
    const authored = new Date(t.authoredOn);
    const modified = t.lastModified ? new Date(t.lastModified) : null;

    if (!modified) continue;
    const days = (modified - authored) / 86400000;
    if (days < 0 || days > 730) continue; // sanity

    durations.push(days);

    const biz = t.businessStatus?.coding?.[0]?.code || "";
    if (["approved","rejected"].includes(biz)) {
      totalSubmitToDecision += days;
      countDecision++;
    }
    if (["response-received","assessment-resumed"].includes(biz)) {
      totalQuestionToResponse += days;
      countQR++;
    }
    if (["validation-passed","under-assessment"].includes(biz)) {
      totalSubmitToAccept += days;
      countAccept++;
    }
  }

  const avgDecisionDays  = countDecision  ? (totalSubmitToDecision  / countDecision).toFixed(1)  : null;
  const avgResponseDays  = countQR        ? (totalQuestionToResponse / countQR).toFixed(1)        : null;
  const avgAcceptDays    = countAccept    ? (totalSubmitToAccept     / countAccept).toFixed(1)    : null;

  // Duration histogram buckets (days): 0-7, 7-30, 30-90, 90-180, 180+
  const durationBuckets = [
    { label: "< 7 days",    min: 0,   max: 7,   count: 0 },
    { label: "7–30 days",   min: 7,   max: 30,  count: 0 },
    { label: "30–90 days",  min: 30,  max: 90,  count: 0 },
    { label: "90–180 days", min: 90,  max: 180, count: 0 },
    { label: "180+ days",   min: 180, max: Infinity, count: 0 },
  ];
  for (const d of durations) {
    const b = durationBuckets.find(b => d >= b.min && d < b.max);
    if (b) b.count++;
  }

  // 9. Per-product (based on Task.for.display or Task.description)
  const byProduct = {};
  for (const t of allTasks) {
    const prod = t.for?.display || extractProductFromDesc(t.description) || "Unknown";
    if (!byProduct[prod]) byProduct[prod] = { total: 0, pending: 0, questions: 0 };
    byProduct[prod].total++;
    const biz = t.businessStatus?.coding?.[0]?.code || "";
    if (SUBMITTER_STAGE[biz]?.submitterAction) byProduct[prod].questions++;
    if (["requested","in-progress","accepted"].includes(t.status)) byProduct[prod].pending++;
  }

  // 10. Document insights
  let totalDocRefs = 0, byDocType = {};
  for (const t of allTasks) {
    for (const inp of (t.input || [])) {
      const ref = inp.valueReference?.reference || "";
      if (ref.startsWith("DocumentReference/")) {
        totalDocRefs++;
        const typeDisplay = inp.type?.coding?.[0]?.display
                         || inp.type?.text
                         || inp.type?.coding?.[0]?.code || "Document";
        byDocType[typeDisplay] = (byDocType[typeDisplay] || 0) + 1;
      }
    }
    for (const out of (t.output || [])) {
      const ref = out.valueReference?.reference || "";
      if (ref.startsWith("DocumentReference/")) {
        totalDocRefs++;
        const typeDisplay = out.type?.coding?.[0]?.display
                          || out.type?.text
                          || out.type?.coding?.[0]?.code || "Document";
        byDocType[typeDisplay] = (byDocType[typeDisplay] || 0) + 1;
      }
    }
  }

  // 11. Timeline events (for client-side chart, last 365 days)
  const yearAgo = new Date(Date.now() - 365 * 86400000);
  const timelineEvents = allTasks
    .filter(t => t.authoredOn && new Date(t.authoredOn) > yearAgo)
    .map(t => {
      const biz  = t.businessStatus?.coding?.[0]?.code || "";
      const code = t.code?.coding?.[0]?.code || "";
      return {
        date:      t.authoredOn,
        modified:  t.lastModified || t.authoredOn,
        code,
        biz,
        status:    t.status || "",
        product:   t.for?.display || extractProductFromDesc(t.description) || "Unknown",
        isSubmitterAction: SUBMITTER_STAGE[biz]?.submitterAction || false,
        isDecision: ["approved","rejected","withdrawn"].includes(biz),
        isQuestion: ["information-request"].includes(code),
        isSubmission: SUBMITTER_CODES.has(code),
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // ── Assemble summary object ───────────────────────────────────
  const summary = {
    totalTasks:           allTasks.length,
    totalSubmissions:     submitterTasks.length,
    totalDecisions:       decisionTasks.length,
    totalAwaitingAction:  awaitingSubmitter.length,
    totalDocRefs,
    avgDecisionDays,
    avgResponseDays,
    avgAcceptDays,
    approved:  (byBizStatus["Approved"]  || byBizStatus["approved"]  || 0),
    rejected:  (byBizStatus["Rejected"]  || byBizStatus["rejected"]  || 0),
    byCode,
    byBizStatus,
    byFhirStatus,
    byStage,
    byModule,
    byProduct,
    byDocType,
    durationBuckets,
    awaitingSubmitter,
  };

  res.render("submitter/annual-report", {
    fhirUrl,
    fetchError,
    summary,
    timelineEventsJson: JSON.stringify(timelineEvents),
    pageTitle: "Submitter Annual Report",
    organizations,
  });
});

// ── Helper used by the route above ──────────────────────────────
function extractProductFromDesc(description) {
  if (!description) return null;
  // Task.description format from APIX: "TaskCode — DrugName (ProcedureId)"
  const m = description.match(/—\s*(.+?)\s*\(/);
  return m ? m[1].trim() : null;
}



// ─────────────────────────────────────────────────────────────────────────────
// Settings — FHIR Authentication
// GET  /settings       → render the settings page
// POST /settings       → save auth config to session
// POST /settings/clear → clear auth config from session
// ─────────────────────────────────────────────────────────────────────────────
app.get("/settings", (req, res) => {
  const _settingsStored = getCredentials();
  res.render("settings", {
    saved: false,
    fhirAuthType:         req.session.fhirAuthType         || _settingsStored.fhirAuthType         || "none",
    fhirApiKey:           req.session.fhirApiKey            || _settingsStored.fhirApiKey            || "",
    fhirBearerToken:      req.session.fhirBearerToken       || _settingsStored.fhirBearerToken       || "",
    fhirCustomHeaderName: req.session.fhirCustomHeaderName  || _settingsStored.fhirCustomHeaderName  || "",
    fhirCustomHeaderValue:req.session.fhirCustomHeaderValue || _settingsStored.fhirCustomHeaderValue || ""
  });
});

app.post("/settings", (req, res) => {
  const { fhirAuthType, fhirApiKey, fhirBearerToken,
          fhirCustomHeaderName, fhirCustomHeaderValue } = req.body;

  req.session.fhirAuthType        = fhirAuthType        || "none";
  req.session.fhirApiKey          = fhirApiKey           || "";
  req.session.fhirBearerToken     = fhirBearerToken      || "";
  req.session.fhirCustomHeaderName  = fhirCustomHeaderName  || "";
  req.session.fhirCustomHeaderValue = fhirCustomHeaderValue || "";

  // Persist to process-level store so credentials survive browser close / new tab
  saveCredentials({
    fhirAuthType:          req.session.fhirAuthType,
    fhirApiKey:            req.session.fhirApiKey,
    fhirBearerToken:       req.session.fhirBearerToken,
    fhirCustomHeaderName:  req.session.fhirCustomHeaderName,
    fhirCustomHeaderValue: req.session.fhirCustomHeaderValue
  });

  res.render("settings", {
    saved: true,
    fhirAuthType:        req.session.fhirAuthType,
    fhirApiKey:          req.session.fhirApiKey,
    fhirBearerToken:     req.session.fhirBearerToken,
    fhirCustomHeaderName:  req.session.fhirCustomHeaderName,
    fhirCustomHeaderValue: req.session.fhirCustomHeaderValue
  });
});

app.post("/settings/clear", (req, res) => {
  req.session.fhirAuthType         = "none";
  req.session.fhirApiKey           = "";
  req.session.fhirBearerToken      = "";
  req.session.fhirCustomHeaderName  = "";
  req.session.fhirCustomHeaderValue = "";
  resetCredentials();
  res.redirect("/settings");
});

// ─────────────────────────────────────────────────────────────────────────────
// FHIR Proxy — server-side proxy for client-side FHIR JSON fetches
// GET /fhir-proxy?url=<encoded-fhir-url>
//
// Relays requests from browser JS (app.js, fhir-references.js) through the
// server so auth headers are injected and the FHIR server is never contacted
// directly from the browser.
//
// SSRF guard: blocks private/loopback/link-local addresses.
// ─────────────────────────────────────────────────────────────────────────────

function isSsrfBlocked(hostname) {
  // Block loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  // Block link-local (AWS metadata, etc.)
  if (/^169\.254\./.test(hostname)) return true;
  // Block private RFC-1918 ranges
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  // Block IPv6 private/loopback
  if (/^\[?::1\]?$/.test(hostname)) return true;
  if (/^\[?fc/.test(hostname)) return true;
  if (/^\[?fd/.test(hostname)) return true;
  return false;
}

app.get("/fhir-proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: "Missing ?url= parameter" });

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only http/https URLs are allowed" });
  }

  // Allow requests that target the user's already-configured FHIR server —
  // the Node.js process already talks to it directly on every server-side call,
  // so proxying it here is no broader than existing trust. This lets the
  // browser-side JSON viewer work against local FHIR servers (e.g. localhost:8080)
  // without disabling the SSRF guard for all other hosts.
  const _configuredBase = req.fhirCtx?.baseUrl || '';
  let _configuredHost = null;
  try { _configuredHost = _configuredBase ? new URL(_configuredBase).host : null; } catch {}
  const _targetHost = parsed.host; // includes port, e.g. "localhost:8080"

  if (_targetHost !== _configuredHost && isSsrfBlocked(parsed.hostname)) {
    return res.status(403).json({ error: "Blocked: target host is not allowed" });
  }

  try {
    const upstreamResp = await axios.get(rawUrl, {
      headers: { ...req.fhirCtx.headers, Accept: "application/fhir+json, application/json" },
      responseType: "json",
      validateStatus: null   // pass all status codes through
    });

    res.status(upstreamResp.status);
    const ct = upstreamResp.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    res.json(upstreamResp.data);

  } catch (err) {
    console.error("/fhir-proxy error:", err.message);
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

//app.listen(3000, () => console.log("Server running on port 3000"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});