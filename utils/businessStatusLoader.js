// utils/businessStatusLoader.js
//import fetch from "node-fetch";

const VS_URL =
  "https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/en/ValueSet-apix-business-status-vs.json";

const CS_URL =
  "https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/en/CodeSystem-apix-business-status.json";

let cached = null;

export async function getBusinessStatus() {
  if (cached) return cached;

  // Load ValueSet (to get system URL)
  const vsRes = await fetch(VS_URL, { headers: { accept: "application/fhir+json" } });
  if (!vsRes.ok) throw new Error("Failed to load BusinessStatus ValueSet");
  const vs = await vsRes.json();

  // Determine system from ValueSet
  const system =
    vs.compose?.include?.[0]?.system ||
    vs.expansion?.contains?.[0]?.system;

  if (!system) throw new Error("BusinessStatus ValueSet missing system");

  // Load CodeSystem (to get actual concepts)
  const csRes = await fetch(CS_URL, { headers: { accept: "application/fhir+json" } });
  if (!csRes.ok) throw new Error("Failed to load BusinessStatus CodeSystem");
  const cs = await csRes.json();

  // Expand CodeSystem concepts (flat list)
  const concepts = (cs.concept || []).map(c => ({
    system,
    code: c.code,
    display: c.display
  }));

  cached = concepts;
  return cached;
}
