// utils/ctdSectionsLoader.js
//import fetch from "node-fetch";

const VS_URL =
  "https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/en/ValueSet-apix-ctd-section-vs.json";

const CS_URL =
  "https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/en/CodeSystem-ctd-section.json";

let cached = null;

export async function getCtdSections() {
  if (cached) return cached;

  // -----------------------------
  // 1. Load ValueSet
  // -----------------------------
  const vsRes = await fetch(VS_URL, {
    headers: { accept: "application/fhir+json" }
  });
  if (!vsRes.ok) throw new Error("Failed to load CTD Section ValueSet");
  const valueSet = await vsRes.json();

  // -----------------------------
  // 2. Load CodeSystem
  // -----------------------------
  const csRes = await fetch(CS_URL, {
    headers: { accept: "application/fhir+json" }
  });
  if (!csRes.ok) throw new Error("Failed to load CTD Section CodeSystem");
  const codeSystem = await csRes.json();

  const system = codeSystem.url;
  const concepts = codeSystem.concept || [];

  // -----------------------------
  // 3. Build a lookup map
  // -----------------------------
  const conceptMap = new Map();

  function indexConcepts(list, parentCode = null) {
    for (const c of list) {
      conceptMap.set(c.code, {
        code: c.code,
        display: c.display,
        parent: parentCode
      });
      if (c.concept) indexConcepts(c.concept, c.code);
    }
  }

  indexConcepts(concepts);

  // -----------------------------
  // 4. Helper: find all descendants
  // -----------------------------
  function getDescendants(rootCode) {
    const results = [];
    for (const [code, info] of conceptMap.entries()) {
      let p = info.parent;
      while (p) {
        if (p === rootCode) {
          results.push(info);
          break;
        }
        p = conceptMap.get(p)?.parent;
      }
    }
    return results;
  }

  // -----------------------------
  // 5. Apply ValueSet rules
  // -----------------------------
  const include = valueSet.compose?.include || [];
  const final = [];

  for (const inc of include) {
    for (const filter of inc.filter || []) {
      if (filter.op === "descendent-of") {
        const root = filter.value;
        const descendants = getDescendants(root);
        final.push(...descendants);
      }
    }
  }

  // Deduplicate
  const unique = new Map();
  for (const c of final) {
    unique.set(c.code, c);
  }

  // -----------------------------
  // 6. Convert to Coding triples
  // -----------------------------
  cached = Array.from(unique.values()).map(c => ({
    system,
    code: c.code,
    display: c.display
  }));

  // Sort by code for UI consistency
  cached.sort((a, b) => a.code.localeCompare(b.code));

  return cached;
}