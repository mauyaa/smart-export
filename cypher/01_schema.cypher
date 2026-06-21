CREATE CONSTRAINT fertilizer_name IF NOT EXISTS
FOR (f:Fertilizer) REQUIRE f.name IS UNIQUE;

CREATE CONSTRAINT substance_name IF NOT EXISTS
FOR (s:Substance) REQUIRE s.name IS UNIQUE;

CREATE CONSTRAINT regulation_code IF NOT EXISTS
FOR (r:Regulation) REQUIRE r.code IS UNIQUE;

CREATE CONSTRAINT crop_name IF NOT EXISTS
FOR (c:Crop) REQUIRE c.name IS UNIQUE;

CREATE CONSTRAINT rejection_id IF NOT EXISTS
FOR (rc:RejectionCase) REQUIRE rc.id IS UNIQUE;

CREATE INDEX substance_cas IF NOT EXISTS
FOR (s:Substance) ON (s.cas_number);

CREATE INDEX fertilizer_brand IF NOT EXISTS
FOR (f:Fertilizer) ON (f.brand);
