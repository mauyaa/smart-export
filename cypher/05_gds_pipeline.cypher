CALL gds.graph.project(
  'productGraph',
  ['Fertilizer', 'Substance'],
  {
    CONTAINS: {orientation: 'UNDIRECTED'}
  }
)
YIELD graphName, nodeCount, relationshipCount;

CALL gds.nodeSimilarity.write('productGraph', {
  writeRelationshipType: 'SIMILAR_TO',
  writeProperty: 'score',
  similarityCutoff: 0.1
})
YIELD nodesCompared, relationshipsWritten;

CALL gds.graph.project(
  'substanceEvidence',
  ['Substance', 'Regulation', 'RejectionCase'],
  {
    RESTRICTED_BY: {orientation: 'UNDIRECTED'},
    CITED_IN: {orientation: 'UNDIRECTED'}
  }
)
YIELD graphName AS g2;

CALL gds.degree.write('substanceEvidence', {
  writeProperty: 'evidenceDegree'
})
YIELD nodePropertiesWritten;

CALL gds.graph.drop('productGraph') YIELD graphName AS dropped1;
CALL gds.graph.drop('substanceEvidence') YIELD graphName AS dropped2;
