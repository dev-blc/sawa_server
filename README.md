# sawa_server

Backend API for the **SAWA** couples social matching app.

> **Before making ANY changes**, read [`RULES.md`](./RULES.md).  
> Architecture plan & API reference: [`PLAN.md`](./PLAN.md).  
> Change history: [`CHANGELOG.md`](./CHANGELOG.md).

---

## Tech Stack

- **Runtime**: Node.js 20 LTS + TypeScript 5
- **Framework**: Express.js
- **Database**: PostgreSQL via **Prisma 6** (`prisma/schema.prisma`)
- **Auth**: JWT (Access + Refresh tokens)
- **Real-time**: Socket.io
- **Validation**: Zod
- **Logging**: Winston + Morgan
- **Process manager**: PM2 (`ecosystem.config.js`)

---

## Setup

### 1. Prerequisites

- Node.js ≥ 20
- MongoDB (local or Atlas)

### 2. Install dependencies

```bash
cd server
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Run in development

```bash
npm run dev
```

### 5. Run in production

```bash
npm run build
npm start
```

---

## Health Check

```
GET http://localhost:5000/health
```

Response:
```json
{
  "success": true,
  "status": "healthy",
  "service": "sawa-server",
  "environment": "development",
  "timestamp": "..."
}
```

---

## API Base URL

```
http://localhost:5000/api/v1
```

See [`PLAN.md`](./PLAN.md) for the full API reference.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint auto-fix |
| `npm test` | Run Jest tests |
| `npm run typecheck` | TypeScript type check without emit |
