-- CreateTable
CREATE TABLE "di_tile_ocr" (
    "id" SERIAL NOT NULL,
    "page_number" INTEGER NOT NULL,
    "tile_id" TEXT NOT NULL,
    "ocr_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "di_tile_ocr_pkey" PRIMARY KEY ("id")
);
