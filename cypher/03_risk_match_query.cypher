MATCH (f:Fertilizer {name: $fertilizerName})
OPTIONAL MATCH (f)-[contains:CONTAINS]->(s:Substance)
OPTIONAL MATCH (s)-[restriction:RESTRICTED_BY]->(reg:Regulation)-[:APPLIES_TO]->(crop:Crop {name: $cropName})
OPTIONAL MATCH (s)-[:CITED_IN]->(rc:RejectionCase)-[:INVOLVED_CROP]->(crop)
OPTIONAL MATCH (s)-[orgRestriction:RESTRICTED_BY]->(orgReg:Regulation {type: 'organic_production'})

WITH f, crop,
     collect(DISTINCT {
       substance: s.name,
       category: s.category,
       restriction: CASE WHEN reg IS NOT NULL THEN {
         regulationCode: reg.code,
         regulationName: reg.name,
         limit: restriction.limit,
         unit: restriction.unit
       } END,
       rejectionCase: CASE WHEN rc IS NOT NULL THEN {
         id: rc.id, date: rc.date, summary: rc.summary, source: rc.source
       } END,
       organicRestriction: CASE WHEN orgReg IS NOT NULL THEN {
         regulationCode: orgReg.code, note: orgRestriction.unit
       } END
     }) AS substanceFindings

WITH f, crop, substanceFindings,
     [x IN substanceFindings WHERE x.rejectionCase IS NOT NULL] AS rejectionHits,
     [x IN substanceFindings WHERE x.restriction IS NOT NULL] AS regulatoryHits,
     [x IN substanceFindings WHERE x.organicRestriction IS NOT NULL] AS organicHits

RETURN
  f.name AS fertilizer,
  crop.name AS crop,
  substanceFindings,
  CASE
    WHEN size(rejectionHits) > 0 THEN 'Risky'
    WHEN size(regulatoryHits) > 0 THEN 'Risky'
    WHEN size(organicHits) > 0 THEN 'Risky'
    WHEN size(substanceFindings) = 0 OR all(x IN substanceFindings WHERE x.substance IS NULL)
      THEN 'Unclear'
    ELSE 'Safe'
  END AS riskLevel,
  rejectionHits,
  regulatoryHits,
  organicHits;
