# Backend (Groq API + Session Store)

This backend runs an HTTP server for the `web/` frontend. It saves chat sessions either:

- **MongoDB Atlas** (recommended for deployment) when `MONGODB_URI` is set, or
- **Local files** in `back/chats/` when `MONGODB_URI` is not set.

## API

- `GET /health`
- `GET /sessions`
- `POST /sessions` → `{ sessionId }`
- `GET /sessions/:id` → `{ session }`
- `POST /chat` (streams text) → request `{ sessionId?, message, model?, systemPrompt? }`

## Setup

1) Install dependencies:

```bash
cd back
npm install
```

2) Create `back/.env` (copy from `back/.env.example`) and set:

- `GROQ_API_KEY`
- `PORT` (optional, default: `4000`)
- `CORS_ORIGIN` (optional, default: `http://localhost:3000`)
- `MONGODB_URI` (Atlas connection string, starts with `mongodb+srv://`)
- `MONGODB_DB` (optional)
- `MONGODB_COLLECTION` (optional)

3) Start:

```bash
npm start
```

## Deploy notes

- Put `MONGODB_URI` and `GROQ_API_KEY` in your hosting provider’s environment variables (do not commit secrets).
- If you already shared your MongoDB password publicly, rotate it in MongoDB Atlas and update `MONGODB_URI`.
