# Veyra analysis agent

A LiveKit agent worker — a separate, persistent Node.js service, not part of
the main Next.js app — that joins every Veyra meeting automatically the
moment it's created, silently transcribes each participant, and once the
meeting ends, scores every participant who spoke on 5 parameters
(communication, fluency, topic relevancy, engagement, clarity/confidence)
via Groq. Results are written straight to the database the main app reads
on the host's meeting-ended screen.

See `src/agent.ts`'s own top-of-file comment for the actual architecture
and why it's built the way it is (including a real, confirmed SDK bug this
deliberately avoids by not using `voice.AgentSession`).

## Local development

```bash
npm install
cp .env.example .env   # fill in the real values
npm run dev
```

`npm run dev` runs the agent in **dev mode** against LiveKit Cloud — it'll
actually register as a worker and receive real dispatches for meetings
created in your LiveKit project, so test against a real (or disposable)
meeting, not a mocked one.

## Deployment (Render, or any host that runs a persistent process)

This **cannot** run on Vercel — same reason the old socket server couldn't:
it's a long-running process, not a request/response serverless function.

1. Push this `agent-worker/` directory as its own service (same pattern as
   the old socket server — a separate deployment from the main Next.js app).
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. Set all the environment variables from `.env.example` in your hosting
   platform's dashboard — never commit a real `.env` file.
5. Once deployed and running, it registers with your LiveKit Cloud project
   and starts receiving dispatches automatically — no further wiring needed
   on the main app's side, since automatic dispatch means LiveKit itself
   sends this worker every new room.

## Database

This service has its **own**, deliberately minimal `prisma/schema.prisma`
— only `Meeting` (read-only, just to resolve a room name to a database id)
and `ParticipantAnalysis` (written here). It is NOT a copy of the main
app's full schema, and does not need to be — Prisma only requires the
models you actually query represented in your own schema file, not the
whole database.

**Important**: if the main app's `Meeting` or `ParticipantAnalysis` models
ever change (new required field, renamed column, etc.), make the matching
change here too — nothing keeps these two schema files in sync
automatically, since they're two independent Prisma projects pointed at
the same physical database.

Run the migration (from the main `veyra/` project, which owns migration
history) before deploying this service for the first time:

```bash
cd ../veyra
npx prisma migrate deploy
```

Then, in this project:

```bash
npx prisma generate
```

## What this does NOT do

- Doesn't speak, doesn't do TTS, doesn't interact with participants at all
  — silent and invisible the entire meeting.
- Doesn't analyze participants who never spoke (nothing to score).
- Doesn't run in real time — the analysis happens once, after the meeting
  ends, not continuously throughout.
