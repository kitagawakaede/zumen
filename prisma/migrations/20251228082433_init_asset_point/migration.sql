-- CreateTable
CREATE TABLE "circle_texts" (
    "id" SERIAL NOT NULL,
    "connected_text" TEXT NOT NULL,
    "page_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circle_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "single_road_texts" (
    "id" SERIAL NOT NULL,
    "road_text" TEXT NOT NULL,
    "page_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "single_road_texts_pkey" PRIMARY KEY ("id")
);
