// Local dev only, in effect — when actually deployed, LiveKit Cloud
// injects secrets directly as real process env vars, so this import is a
// no-op there. Locally there's no equivalent injection: `prisma generate`
// (run just before this file, in package.json's dev script) loads .env
// for ITSELF via prisma.config.ts, but that's a separate process — it
// doesn't hand those variables to this one. Without this line,
// ServerOptions() further down reads empty LIVEKIT_API_KEY etc. and
// throws MissingCredentialsError the moment this file is run locally.
import "dotenv/config";

/**
 * Veyra's meeting-analysis agent. Automatic dispatch (no `agentName` set
 * below — see ServerOptions — which is what makes LiveKit join this agent
 * to every new room instead of requiring an explicit request) means this
 * joins every Veyra meeting silently, the moment it's created, and stays
 * for the room's whole lifetime — including stretches where everyone's
 * temporarily left — until the meeting is actually ended.
 *
 * Deliberately built on the low-level room/track APIs (`@livekit/rtc-node`)
 * and a standalone `deepgram.STT` stream per participant, NOT the
 * framework's `voice.AgentSession`. Two reasons, not one:
 *
 *   1. This agent never speaks, never responds conversationally, and never
 *      needs turn-taking/interruption handling — everything AgentSession
 *      exists to orchestrate. It only needs to listen.
 *   2. More importantly: the documented pattern for AgentSession-based
 *      multi-participant transcription (one listen-only AgentSession per
 *      remote participant, per LiveKit's own multi-user-transcriber
 *      example) crashes in the installed SDK version (1.9.0) — confirmed
 *      by reading agent_session.js directly, not just the GitHub issue
 *      describing it (livekit/agents-js#1934, open/unmerged at the time
 *      this was written): every AgentSession.start({room}) unconditionally
 *      creates a SessionHost bound to a room-wide "lk.agent.session" byte
 *      stream topic, and a room only allows one handler per topic — so the
 *      second participant's session throws. Going straight to the
 *      lower-level APIs sidesteps that bug entirely rather than working
 *      around it.
 *
 * Meeting-end detection: listens for the SAME "meeting:ended" data message
 * the main app already broadcasts — both when the host explicitly ends a
 * meeting (see livekit-emitters.ts's emitToMeeting, called from POST
 * /api/rooms/[token]/end) AND when the main app's own daily inactivity
 * sweep closes out a meeting nobody ever explicitly ended (see the main
 * app's src/app/api/cron/expire-meetings route) — this agent is just
 * another room participant from LiveKit's perspective, so it receives
 * either broadcast exactly like any client does. This is deliberately NOT
 * inferred from the room merely emptying: people leaving and rejoining
 * the same still-open meeting is normal, and treating "empty" as "over"
 * would end analysis (and disconnect the agent) prematurely, losing
 * anything said after a rejoin. A moderate empty-room timeout still
 * exists further down as a fallback for the common case where nobody
 * explicitly ends the meeting at all (most people just leave) — without
 * it, analysis would depend entirely on either the host remembering to
 * click "End for everyone" or the main app's cron eventually catching it
 * up to 2 days later, neither of which is a reasonable wait in practice.
 */
import {
  type JobContext,
  ServerOptions,
  AutoSubscribe,
  cli,
  defineAgent,
  stt as sttNamespace,
} from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import {
  AudioStream,
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { analyzeMeeting, summarizeParticipants, type ParticipantTranscript } from "./analysis.js";
import { prisma } from "./db.js";

// Pure safety net, not the primary end-of-meeting signal (see the
// meeting:ended listener below, which is) — covers the case of a room
// nobody explicitly ends (very common in practice: most people just
// leave rather than clicking "End meeting for everyone"), so analysis
// still runs in a reasonable timeframe instead of waiting on a signal
// that may never come. Long enough to survive a brief reconnect (a
// network blip, someone stepping away for a few minutes and coming
// back), short enough that a meeting that's actually over gets analyzed
// promptly rather than the host waiting around wondering why nothing
// happened. The main app's own daily inactivity sweep (2 days — see
// src/lib/meeting-expiry.ts in the main app) is a separate, much longer-
// horizon cleanup for meetings that were never properly closed out at
// all; this timeout is about a single already-in-progress room, not that.
const ABANDONED_ROOM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface TrackedParticipant {
  identity: string;
  userId: number;
  name: string;
  segments: string[];
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const participants = new Map<string, TrackedParticipant>();
    const sttStreams = new Map<string, deepgram.SpeechStream>();
    let abandonedTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    // Set only after connect() resolves — ctx.room.name is empty/undefined
    // before that point, so reading it any earlier (as an earlier version
    // of this file did) silently produces "" for every log line AND for
    // the Meeting lookup at analysis time, meaning nothing ever matched
    // and nothing was ever saved. Read it fresh from ctx.room.name at each
    // use below instead of trusting a variable that could theoretically
    // go stale, since there's no actual cost to doing so.
    let roomName = "";

    const getOrCreateTracked = (participant: RemoteParticipant): TrackedParticipant | null => {
      const existing = participants.get(participant.identity);
      if (existing) return existing;
      const userId = Number(participant.identity);
      if (!Number.isFinite(userId)) {
        // Identity should always be String(userId) — see src/lib/livekit.ts
        // in the main app's token minting. A non-numeric identity means
        // this connection isn't a real meeting participant (shouldn't
        // happen in practice), so there's nothing meaningful to record
        // scores against.
        console.warn(`[analysis-agent] skipping non-numeric identity "${participant.identity}"`);
        return null;
      }
      const created: TrackedParticipant = {
        identity: participant.identity,
        userId,
        name: participant.name || `Participant ${userId}`,
        segments: [],
      };
      participants.set(participant.identity, created);
      return created;
    };

    // Wires a fresh Deepgram stream to a participant's CURRENT audio
    // track. Called on every TrackSubscribed for a mic track — including
    // a rejoin after a temporary disconnect — not just the first time a
    // given identity is seen, since a rejoin publishes a brand-new track
    // that needs its own new AudioStream/SpeechStream piped in. Their
    // accumulated `segments` from before the gap are preserved either way
    // (getOrCreateTracked returns the existing entry rather than a fresh
    // one), so the transcript keeps accumulating across the gap instead
    // of restarting.
    const wireTranscription = (participant: RemoteParticipant, track: RemoteTrack) => {
      const tracked = getOrCreateTracked(participant);
      if (!tracked) return;

      // A stale stream from a previous session for this same identity
      // (e.g. they left and are now rejoining) would otherwise leak —
      // close it before wiring the new one.
      sttStreams.get(participant.identity)?.close();

      const sttInstance = new deepgram.STT({
        apiKey: process.env.DEEPGRAM_API_KEY,
        model: (process.env.DEEPGRAM_STT_MODEL as deepgram.STTOptions["model"]) || "nova-2-meeting",
        language: "en",
        smartFormat: true,
        punctuate: true,
      });
      const speechStream = sttInstance.stream();
      const audioStream = new AudioStream(track);
      speechStream.updateInputStream(audioStream);
      sttStreams.set(participant.identity, speechStream);

      (async () => {
        try {
          for await (const event of speechStream) {
            if (event.type !== sttNamespace.SpeechEventType.FINAL_TRANSCRIPT) continue;
            const text = event.alternatives?.[0]?.text?.trim();
            if (text) participants.get(participant.identity)?.segments.push(text);
          }
        } catch (err) {
          // A single participant's STT connection dying (network blip on
          // Deepgram's side, etc.) shouldn't take down the whole agent —
          // whatever was already transcribed for them still gets
          // analyzed at meeting-end; they just stop accumulating more
          // (or resume cleanly if they reconnect, via this same path).
          console.error(`[analysis-agent] STT stream error for identity ${participant.identity}:`, err);
        }
      })();
    };

    const scheduleAbandonedCheck = () => {
      if (abandonedTimer) clearTimeout(abandonedTimer);
      abandonedTimer = setTimeout(() => {
        if (ctx.room.remoteParticipants.size > 0) return; // someone's back — not abandoned
        void finishUp("room abandoned — no explicit end signal received");
      }, ABANDONED_ROOM_TIMEOUT_MS);
    };

    const finishUp = async (reason: string) => {
      if (finished) return;
      finished = true;
      if (abandonedTimer) clearTimeout(abandonedTimer);
      console.log(`[analysis-agent] ${roomName}: wrapping up (${reason}), ${participants.size} participant(s) tracked`);

      for (const stream of sttStreams.values()) {
        try {
          stream.close();
        } catch {
          // Already closed/errored — fine, this is just cleanup.
        }
      }

      try {
        await runAnalysisAndSave(roomName, participants);
      } catch (err) {
        console.error(`[analysis-agent] ${roomName}: analysis/save failed:`, err);
      }

      ctx.shutdown(reason);
    };

    // Registered before connect() resolves, not after — the room object
    // already exists at this point (see JobContext), and this ordering
    // is what guarantees no early event (e.g. from participants already
    // in the room when this agent was dispatched) is missed.
    ctx.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        if (publication.source !== TrackSource.SOURCE_MICROPHONE) return; // not screen-share audio
        wireTranscription(participant, track);
      },
    );

    ctx.room.on(RoomEvent.TrackUnsubscribed, (_track, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) return;
      // Stop and drop their STT stream (nothing left to transcribe until
      // they republish), but deliberately leave their TrackedParticipant
      // entry — and its accumulated segments — in `participants`. It's
      // only ever cleared at finishUp, so a later rejoin's segments
      // append to what's already there rather than starting over.
      sttStreams.get(participant.identity)?.close();
      sttStreams.delete(participant.identity);
    });

    // Primary end-of-meeting trigger: the same broadcast every client
    // receives when the host ends the meeting for everyone. Server-sent
    // (via RoomServiceClient.sendData from the API route, not a
    // participant's own publishData), so — unlike reactions/hand-raise —
    // there's no "sender" to check or self-filter here.
    ctx.room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      try {
        const decoded = new TextDecoder().decode(payload);
        const parsed = JSON.parse(decoded) as { event?: string };
        if (parsed.event === "meeting:ended") {
          void finishUp("meeting:ended received");
        }
      } catch {
        // Not a message this agent cares about / not JSON — ignore.
      }
    });

    ctx.room.on(RoomEvent.Disconnected, () => {
      // The agent itself got disconnected (network issue, the room
      // being force-closed server-side, etc.) — can't keep monitoring
      // either way, so wrap up with whatever was captured rather than
      // losing it silently. A real, if less common, path to finishing
      // alongside the meeting:ended message above.
      void finishUp("agent disconnected");
    });

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    roomName = ctx.room.name ?? "";
    console.log(`[analysis-agent] joined room ${roomName}`);

    // Starts the long-window abandoned-room safety net if the room is
    // already empty right after connecting (e.g. this agent was slow to
    // dispatch and everyone's already left) — mirrors the same check
    // inside ParticipantDisconnected below for the case where it happens
    // later instead.
    if (ctx.room.remoteParticipants.size === 0) scheduleAbandonedCheck();
    ctx.room.on(RoomEvent.ParticipantDisconnected, () => {
      if (ctx.room.remoteParticipants.size === 0) scheduleAbandonedCheck();
      else if (abandonedTimer) {
        clearTimeout(abandonedTimer);
        abandonedTimer = null;
      }
    });
  },
});

async function runAnalysisAndSave(roomName: string, participants: Map<string, TrackedParticipant>) {
  console.log(`[analysis-agent] ${roomName}: runAnalysisAndSave starting, ${participants.size} participant(s) in map`);
  const transcripts: ParticipantTranscript[] = [];
  for (const p of participants.values()) {
    if (p.segments.length === 0) continue; // never said anything — nothing to analyze
    transcripts.push({ userId: p.userId, name: p.name, text: p.segments.join(" ") });
  }
  if (transcripts.length === 0) {
    console.log(`[analysis-agent] ${roomName}: nobody had a transcribable transcript, skipping analysis`);
    return;
  }

  const meeting = await prisma.meeting.findUnique({ where: { token: roomName } });
  if (!meeting) {
    console.error(`[analysis-agent] ${roomName}: no matching Meeting row found — can't save analysis`);
    return;
  }
  console.log(`[analysis-agent] ${roomName}: found Meeting id=${meeting.id}, hostId=${meeting.hostId} — calling Groq for ${transcripts.length} transcript(s)`);

  // The host's own transcript is still sent to Groq below, deliberately —
  // their questions and prompts are part of what gives the model context
  // to judge everyone else's responses. It's only excluded HERE, at the
  // save step: this is analysis of the meeting's other participants, not
  // of the person running it.
  const participantTranscripts = transcripts.filter((t) => t.userId !== meeting.hostId);
  if (participantTranscripts.length > 0) {
    try {
      const meetingSummary = await summarizeParticipants(participantTranscripts);
      await prisma.meeting.update({ where: { id: meeting.id }, data: { meetingSummary } });
      console.log(`[analysis-agent] ${roomName}: saved participant-only meeting summary`);
    } catch (err) {
      console.error(`[analysis-agent] ${roomName}: meeting summary failed:`, err);
    }
  }

  const scores = await analyzeMeeting(transcripts);
  console.log(`[analysis-agent] ${roomName}: Groq call returned, ${scores.size} scored entr(ies) — writing to DB`);
  let savedCount = 0;
  for (const t of transcripts) {
    if (t.userId === meeting.hostId) continue;
    const s = scores.get(t.userId);
    if (!s) continue; // the model didn't return an entry for this participant
    await prisma.participantAnalysis.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId: t.userId } },
      create: { meetingId: meeting.id, userId: t.userId, name: t.name, ...s },
      update: { name: t.name, ...s },
    });
    savedCount += 1;
  }
  console.log(`[analysis-agent] ${roomName}: saved analysis for ${savedCount} participant(s) (host excluded)`);
}

cli.runApp(
  new ServerOptions({
    agent: import.meta.filename,
    wsURL: process.env.LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
  }),
);
