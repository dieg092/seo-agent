-- Validez de la calibración editorial (correlación nota–GSC) guardada en cada pasada:
-- la guarda solo deja fusionar mejoras de artículos con validez demostrada y reciente.
ALTER TABLE "seo_agent"."EditorialCalibration" ADD COLUMN "validityN" INTEGER;
ALTER TABLE "seo_agent"."EditorialCalibration" ADD COLUMN "validityRho" DOUBLE PRECISION;
ALTER TABLE "seo_agent"."EditorialCalibration" ADD COLUMN "validityAt" TIMESTAMP(3);
