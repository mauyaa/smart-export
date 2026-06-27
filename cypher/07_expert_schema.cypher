// ── Expert constraints & indexes ──────────────────────────────────────────

CREATE CONSTRAINT expert_id IF NOT EXISTS
FOR (e:Expert) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT escalation_id IF NOT EXISTS
FOR (esc:Escalation) REQUIRE esc.id IS UNIQUE;

CREATE CONSTRAINT county_name IF NOT EXISTS
FOR (co:County) REQUIRE co.name IS UNIQUE;

CREATE INDEX expert_email IF NOT EXISTS
FOR (e:Expert) ON (e.email);

CREATE INDEX escalation_status IF NOT EXISTS
FOR (esc:Escalation) ON (esc.status);

CREATE INDEX escalation_ts IF NOT EXISTS
FOR (esc:Escalation) ON (esc.created_at);

// ── Expert nodes ───────────────────────────────────────────────────────────
// Each expert has:
//   - id, name, email, phone
//   - county (location)
//   - crop_tags (list of crops they specialize in)
//   - substance_tags (list of substances they know about)
//   - organization (who they work for)
//   - active (whether they are currently accepting cases)

// ── Relationships ──────────────────────────────────────────────────────────
// (:Expert)-[:COVERS_COUNTY]->(:County)
// (:Expert)-[:SPECIALIZES_IN]->(:Crop)
// (:Expert)-[:KNOWS_SUBSTANCE]->(:Substance)
// (:Escalation)-[:ABOUT_CROP]->(:Crop)
// (:Escalation)-[:ABOUT_FERTILIZER]->(:Fertilizer)
// (:Escalation)-[:IN_COUNTY]->(:County)
// (:Escalation)-[:MATCHED_TO]->(:Expert)