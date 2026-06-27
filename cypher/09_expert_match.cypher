// ── Expert matching query ──────────────────────────────────────────────────
// Given a crop, county, and list of flagged substances,
// find the best matching active expert.
//
// Scoring:
//   +3 if expert covers the farmer's county
//   +2 if expert specializes in the farmer's crop
//   +1 per matching substance tag
//
// Returns the top 1 expert by score.
//
// NOTE: this file must be named exactly "09_expert_match.cypher" —
// api/main.py's load_expert_match_query() loads it by that filename.

MATCH (e:Expert {active: true})

// County match
OPTIONAL MATCH (e)-[:COVERS_COUNTY]->(co:County {name: $county})

// Crop match
OPTIONAL MATCH (e)-[:SPECIALIZES_IN]->(cr:Crop {name: $crop})

// Substance match
OPTIONAL MATCH (e)-[:KNOWS_SUBSTANCE]->(s:Substance)
WHERE s.name IN $substances

WITH e,
     CASE WHEN co IS NOT NULL THEN 3 ELSE 0 END AS countyScore,
     CASE WHEN cr IS NOT NULL THEN 2 ELSE 0 END AS cropScore,
     COUNT(DISTINCT s) AS substanceScore

WITH e,
     countyScore + cropScore + substanceScore AS totalScore

WHERE totalScore > 0

RETURN
  e.id AS expertId,
  e.name AS expertName,
  e.email AS expertEmail,
  e.phone AS expertPhone,
  e.organization AS organization,
  e.bio AS bio,
  e.crop_tags AS cropTags,
  totalScore

ORDER BY totalScore DESC
LIMIT 1
