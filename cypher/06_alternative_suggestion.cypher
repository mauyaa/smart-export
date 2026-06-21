MATCH (f:Fertilizer {name: $fertilizerName})-[sim:SIMILAR_TO]-(alt:Fertilizer)
WHERE NOT EXISTS {
  MATCH (alt)-[:CONTAINS]->(s:Substance)-[:RESTRICTED_BY]->(:Regulation)-[:APPLIES_TO]->(:Crop {name: $cropName})
}
RETURN alt.name AS alternativeProduct, alt.brand AS brand, sim.score AS similarityScore
ORDER BY sim.score DESC
LIMIT 3;
