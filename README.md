# JRzumen

Next.js (App Router) + TypeScript system for extracting circled text and road text
from blueprint PDFs using Azure Document Intelligence and Gemini Pro Vision.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure `.env` with your credentials.

3. Initialize the database:

```bash
npx prisma migrate dev --name init
```

4. Start the dev server:

```bash
npm run dev
```

## API

- `POST /api/analyze` accepts `multipart/form-data` with a `file` field (PDF). It
  runs OCR, renders PNG pages, sends each page to Gemini, and saves results.
- `POST /api/save` accepts JSON `{ page_number, circle_connected_texts, single_road_texts }`
  and saves the results to the database.
