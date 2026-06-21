MERGE (r1:Regulation {code: 'EU 2021/1165'})
  SET r1.name = 'Organic Production Rules', r1.type = 'organic_production';

MERGE (r2:Regulation {code: 'EU 2019/1009'})
  SET r2.name = 'Fertilising Products Regulation', r2.type = 'fertiliser_contaminant';

MERGE (r3:Regulation {code: 'EU 2023/915'})
  SET r3.name = 'Maximum Levels of Contaminants in Food', r3.type = 'food_contaminant';

MERGE (r4:Regulation {code: 'EU MRL Pesticides'})
  SET r4.name = 'EU Pesticides Database — Maximum Residue Levels', r4.type = 'pesticide_mrl';

MERGE (:Crop {name: 'French beans'});
MERGE (:Crop {name: 'Avocado'});
MERGE (:Crop {name: 'Snow peas'});
MERGE (:Crop {name: 'Passion fruit'});
MERGE (:Crop {name: 'Maize'});

MERGE (s1:Substance {name: 'Cadmium'})
  SET s1.cas_number = '7440-43-9', s1.category = 'heavy_metal';

MERGE (s2:Substance {name: 'Acephate'})
  SET s2.cas_number = '30560-19-1', s2.category = 'organophosphate_pesticide';

MERGE (s3:Substance {name: 'Chlorpyrifos'})
  SET s3.cas_number = '2921-88-2', s3.category = 'organophosphate_pesticide';

MERGE (s4:Substance {name: 'Mancozeb'})
  SET s4.cas_number = '8018-01-7', s4.category = 'fungicide';

MERGE (s5:Substance {name: 'Diazinon'})
  SET s5.cas_number = '333-41-5', s5.category = 'organophosphate_pesticide';

MERGE (s6:Substance {name: 'Lead'})
  SET s6.cas_number = '7439-92-1', s6.category = 'heavy_metal';

MERGE (s7:Substance {name: 'Nitrogen (Urea form)'})
  SET s7.cas_number = '57-13-6', s7.category = 'macronutrient';

MERGE (s8:Substance {name: 'Potassium chloride'})
  SET s8.cas_number = '7447-40-7', s8.category = 'macronutrient';

MATCH (s:Substance {name: 'Cadmium'}), (r:Regulation {code: 'EU 2019/1009'})
MERGE (s)-[:RESTRICTED_BY {limit: 60, unit: 'mg/kg P2O5'}]->(r);

MATCH (s:Substance {name: 'Lead'}), (r:Regulation {code: 'EU 2019/1009'})
MERGE (s)-[:RESTRICTED_BY {limit: 120, unit: 'mg/kg dry matter'}]->(r);

MATCH (s:Substance {name: 'Acephate'}), (r:Regulation {code: 'EU MRL Pesticides'})
MERGE (s)-[:RESTRICTED_BY {limit: 0.01, unit: 'mg/kg'}]->(r);

MATCH (s:Substance {name: 'Chlorpyrifos'}), (r:Regulation {code: 'EU MRL Pesticides'})
MERGE (s)-[:RESTRICTED_BY {limit: 0.01, unit: 'mg/kg'}]->(r);

MATCH (s:Substance {name: 'Diazinon'}), (r:Regulation {code: 'EU MRL Pesticides'})
MERGE (s)-[:RESTRICTED_BY {limit: 0.01, unit: 'mg/kg'}]->(r);

MATCH (s:Substance {name: 'Mancozeb'}), (r:Regulation {code: 'EU MRL Pesticides'})
MERGE (s)-[:RESTRICTED_BY {limit: 0.05, unit: 'mg/kg'}]->(r);

MATCH (s:Substance {name: 'Chlorpyrifos'}), (r:Regulation {code: 'EU 2021/1165'})
MERGE (s)-[:RESTRICTED_BY {limit: 0, unit: 'not authorized for organic use'}]->(r);

MATCH (s:Substance {name: 'Acephate'}), (r:Regulation {code: 'EU 2021/1165'})
MERGE (s)-[:RESTRICTED_BY {limit: 0, unit: 'not authorized for organic use'}]->(r);

MATCH (r:Regulation {code: 'EU MRL Pesticides'}), (c:Crop {name: 'French beans'})
MERGE (r)-[:APPLIES_TO]->(c);
MATCH (r:Regulation {code: 'EU MRL Pesticides'}), (c:Crop {name: 'Snow peas'})
MERGE (r)-[:APPLIES_TO]->(c);
MATCH (r:Regulation {code: 'EU MRL Pesticides'}), (c:Crop {name: 'Avocado'})
MERGE (r)-[:APPLIES_TO]->(c);
MATCH (r:Regulation {code: 'EU MRL Pesticides'}), (c:Crop {name: 'Passion fruit'})
MERGE (r)-[:APPLIES_TO]->(c);
MATCH (r:Regulation {code: 'EU 2019/1009'}), (c:Crop {name: 'Maize'})
MERGE (r)-[:APPLIES_TO]->(c);
MATCH (r:Regulation {code: 'EU 2021/1165'}), (c:Crop {name: 'French beans'})
MERGE (r)-[:APPLIES_TO]->(c);

MERGE (f1:Fertilizer {name: 'Duduthrin 1.75EC'}) SET f1.brand = 'Generic AgroDealer KE';
MERGE (f2:Fertilizer {name: 'Orthene 75SP'}) SET f2.brand = 'Generic AgroDealer KE';
MERGE (f3:Fertilizer {name: 'Dudu Diazinon 60EC'}) SET f3.brand = 'Generic AgroDealer KE';
MERGE (f4:Fertilizer {name: 'Ridomil Gold MZ 68WG'}) SET f4.brand = 'Syngenta';
MERGE (f5:Fertilizer {name: 'NPK 17:17:17'}) SET f5.brand = 'MEA Fertilizer';
MERGE (f6:Fertilizer {name: 'Muriate of Potash'}) SET f6.brand = 'Yara';
MERGE (f7:Fertilizer {name: 'CAN (Calcium Ammonium Nitrate)'}) SET f7.brand = 'Toyota Tsusho';

MATCH (f:Fertilizer {name: 'Duduthrin 1.75EC'}), (s:Substance {name: 'Chlorpyrifos'})
MERGE (f)-[:CONTAINS {concentration: '17.5 g/L'}]->(s);

MATCH (f:Fertilizer {name: 'Orthene 75SP'}), (s:Substance {name: 'Acephate'})
MERGE (f)-[:CONTAINS {concentration: '750 g/kg'}]->(s);

MATCH (f:Fertilizer {name: 'Dudu Diazinon 60EC'}), (s:Substance {name: 'Diazinon'})
MERGE (f)-[:CONTAINS {concentration: '600 g/L'}]->(s);

MATCH (f:Fertilizer {name: 'Ridomil Gold MZ 68WG'}), (s:Substance {name: 'Mancozeb'})
MERGE (f)-[:CONTAINS {concentration: '640 g/kg'}]->(s);

MATCH (f:Fertilizer {name: 'NPK 17:17:17'}), (s:Substance {name: 'Cadmium'})
MERGE (f)-[:CONTAINS {concentration: 'trace — 45mg/kg P2O5'}]->(s);
MATCH (f:Fertilizer {name: 'NPK 17:17:17'}), (s:Substance {name: 'Nitrogen (Urea form)'})
MERGE (f)-[:CONTAINS {concentration: '17%'}]->(s);

MATCH (f:Fertilizer {name: 'Muriate of Potash'}), (s:Substance {name: 'Potassium chloride'})
MERGE (f)-[:CONTAINS {concentration: '60% K2O'}]->(s);

MATCH (f:Fertilizer {name: 'CAN (Calcium Ammonium Nitrate)'}), (s:Substance {name: 'Nitrogen (Urea form)'})
MERGE (f)-[:CONTAINS {concentration: '26%'}]->(s);

MERGE (rc1:RejectionCase {id: 'KE-2020-001'})
  SET rc1.date = date('2020-06-15'),
      rc1.source = 'Expert committee report (cited Greenpeace Africa)',
      rc1.summary = 'Kenyan fine beans rejected at EU border for excess Acephate residue.';

MATCH (s:Substance {name: 'Acephate'}), (rc:RejectionCase {id: 'KE-2020-001'})
MERGE (s)-[:CITED_IN]->(rc);
MATCH (rc:RejectionCase {id: 'KE-2020-001'}), (c:Crop {name: 'French beans'})
MERGE (rc)-[:INVOLVED_CROP]->(c);

MERGE (rc2:RejectionCase {id: 'KE-2022-014'})
  SET rc2.date = date('2022-09-01'),
      rc2.source = 'RASFF Window (illustrative — verify exact notification ID before demo)',
      rc2.summary = 'Pesticide residue violation flagged in Kenyan horticultural consignment.';

MATCH (s:Substance {name: 'Chlorpyrifos'}), (rc:RejectionCase {id: 'KE-2022-014'})
MERGE (s)-[:CITED_IN]->(rc);
MATCH (rc:RejectionCase {id: 'KE-2022-014'}), (c:Crop {name: 'Snow peas'})
MERGE (rc)-[:INVOLVED_CROP]->(c);
