# Fieldnote / Agency Ops

Real-time client project dashboard for a small agency. The application combines role-based access control, PostgreSQL persistence, task workflows, durable activity history, Socket.IO updates, notifications, and scheduled overdue-task processing.

## Stack

- Frontend: React 18, TypeScript, Vite
- API: Node.js, Express, TypeScript
- Database: PostgreSQL with Prisma ORM
- Realtime: Socket.IO over WebSockets
- Scheduled work: node-cron
- Local infrastructure: Docker Compose or a direct PostgreSQL installation

## Roles and access

| Role | Access |
| --- | --- |
| Admin | Global project/task/activity visibility, user role management, client/project/task management |
| Project Manager | Projects they created, tasks in those projects, task assignment and status management |
| Developer | Tasks assigned to them, status updates for those tasks, task-specific activity |

Authorization is enforced in the API. Frontend controls are only a usability layer and are not security boundaries.

New users are created by an authenticated administrator through `POST /api/users`; there is no public self-registration route. This keeps role assignment under administrative control. After creation, reload the workspace to see the new team member in the admin user list.

## Run locally

### Docker PostgreSQL

Requirements: Node.js 20+, Docker Desktop, and npm.

```powershell
npm install
docker compose up -d
npm run db:generate
npm run db:migrate --workspace server -- --name init
npm run db:seed
npm run dev
```

### Direct PostgreSQL

Docker is optional. Create a PostgreSQL database named `agency_dashboard`, then copy `server/.env.example` to `server/.env` and set the connection string:

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/agency_dashboard?schema=public"
```

Then run the migration, seed, and development commands above.

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/api/health`.

## Deploy

Deploy the API and frontend as separate services because Socket.IO needs a long-running Node process.

### Backend: Render

1. Create a new Render Blueprint from this repository; `render.yaml` provisions PostgreSQL and the API service.
2. Set `CLIENT_ORIGIN` to the final Vercel URL.
3. Confirm the generated `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` values are present.
4. After deployment, verify `https://YOUR-API.onrender.com/api/health` returns `{ "status": "ok" }`.

The Render service runs Prisma migrations before starting the API. Run the seed once from a secure environment against the production `DATABASE_URL`; do not publish production seed passwords.

### Frontend: Vercel

1. Import the repository into Vercel.
2. Set the project root to `client`.
3. Set the build command to `npm run build` and the output directory to `dist`.
4. Add `VITE_API_URL=https://YOUR-API.onrender.com` in Vercel project environment variables.
5. Redeploy, then update the Render `CLIENT_ORIGIN` value with the exact Vercel domain.

The local Vite proxy remains available for development; deployed requests use `VITE_API_URL` and the API's CORS/HttpOnly-cookie configuration.

## Seed accounts

All seeded accounts use `password123` locally.

| Role | Email |
| --- | --- |
| Admin | `admin@agency.com` |
| Project Manager | `pm@agency.com` |
| Project Manager | `pm2@agency.com` |
| Developer | `dev@agency.com` |
| Developer | `dev2@agency.com` |
| Developer | `dev3@agency.com` |
| Developer | `dev4@agency.com` |

The seed creates 3 clients, 3 projects, 15 tasks, at least 2 overdue tasks, and pre-existing activity entries. It also validates the required role and data counts before exiting successfully.

## Architecture

### Schema

```mermaid
erDiagram
  USER ||--o{ PROJECT : creates
  USER ||--o{ TASK : develops
  USER ||--o{ ACTIVITY : performs
  USER ||--o{ NOTIFICATION : receives
  USER ||--o{ REFRESH_TOKEN : owns
  CLIENT ||--o{ PROJECT : has
  PROJECT ||--o{ TASK : contains
  PROJECT ||--o{ ACTIVITY : records
  TASK ||--o{ ACTIVITY : records
```

`Activity` stores actor, project, task, previous status, next status, message, and timestamp. It is not derived from the current task state. Foreign keys use restrictive, cascading, or nullifying deletes according to ownership semantics.

### Key decisions

- **Socket.IO:** provides authenticated connections, presence, reconnect handling, and rooms. Admins use a global room, managers use project rooms, and developers use task-specific rooms.
- **Missed events:** the latest 20 authorized activity rows are fetched from PostgreSQL on login/reconnect. Events are not recovered from process memory.
- **Tokens:** short-lived access tokens stay in client memory. Rotating refresh tokens are hashed in PostgreSQL and delivered only through an HttpOnly cookie.
- **Overdue jobs:** node-cron runs the overdue scan hourly and updates the persisted `overdue` flag. Production should run one scheduler instance or move this job to a queue worker.
- **Indexes:** indexes cover project ownership, task project/status, developer/status, due-date scans, priority ordering, and activity ordering by project, user, and task.

## Verification

```powershell
npm run typecheck
npm run build
npx prisma validate --schema server/prisma/schema.prisma
```

## Explanation

The hardest problem was implementing a real-time activity feed without weakening authorization. Every API route applies role and ownership checks, but the same policy also has to apply to WebSocket rooms. Socket.IO connections are authenticated with the access token. Administrators join a global room, project managers join rooms for projects they created, and developers join task-specific rooms only for tasks assigned to them. This prevents a developer from receiving another developer's task events even when both tasks belong to the same project. Every activity change is written to PostgreSQL before its socket event is emitted. On login or reconnect, the client fetches the latest authorized activity records from the database, so offline events are recovered without relying on in-memory server state. Refresh tokens are rotated, hashed in the database, and stored in an HttpOnly cookie, while access tokens remain in memory. The overdue flag is maintained by an hourly node-cron job. If I were extending this for production, I would move scheduled work to a dedicated queue worker and add a shared Socket.IO adapter for horizontally scaled API instances.

## Known limitations

- A production deployment needs hosted PostgreSQL and production secrets; local seed credentials must never be reused.
- Socket.IO requires a long-running Node process. Deploy the API on a WebSocket-capable host and deploy the Vite frontend separately; Vercel can host the frontend, but its serverless functions are not suitable for the Socket.IO process.
- node-cron must be single-instance in production to avoid duplicate overdue scans.
