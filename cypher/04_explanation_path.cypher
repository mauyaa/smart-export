MATCH (f:Fertilizer {name: $fertilizerName})
MATCH p = shortestPath((f)-[*..4]-(reg:Regulation))
RETURN
  [n IN nodes(p) | {labels: labels(n), props: properties(n)}] AS pathNodes,
  [r IN relationships(p) | {type: type(r), props: properties(r)}] AS pathRels

UNION

MATCH (f:Fertilizer {name: $fertilizerName})
MATCH p = shortestPath((f)-[*..4]-(rc:RejectionCase))
RETURN
  [n IN nodes(p) | {labels: labels(n), props: properties(n)}] AS pathNodes,
  [r IN relationships(p) | {type: type(r), props: properties(r)}] AS pathRels;
