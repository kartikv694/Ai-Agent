/**
 * Turns accumulated per-participant transcripts into 6-parameter scores,
 * via a direct call to Groq's chat completions endpoint (OpenAI-compatible
 * — Groq has no dedicated LiveKit Agents plugin, and this doesn't need the
 * framework's streaming/conversational LLM abstraction anyway: it's a
 * single one-shot "here's the transcript, score it" call, not a back-and-
 * forth chat).
 *
 * Deliberately ONE call scoring every participant together, not one call
 * per participant analyzed in isolation. Several of the six parameters
 * (topic knowledge, teamwork & listening, leadership & initiative) are
 * meaningless without knowing what the *group* was actually discussing
 * and how each person's contribution related to and built on others' — an
 * isolated transcript for one person gives the model nothing to judge
 * "relevant to what" or "responsive to whom" against.
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";

export interface ParticipantTranscript {
  userId: number;
  name: string;
  /** Concatenated final transcript segments, in the order they were spoken. */
  text: string;
}

export interface ParticipantScores {
  communication: number;
  fluency: number;
  topicKnowledge: number;
  teamworkListening: number;
  leadershipInitiative: number;
  confidenceProfessionalism: number;
  summary: string | null;
}

/** Summarizes only the supplied participant transcripts; callers must omit the host. */
export async function summarizeParticipants(participants: ParticipantTranscript[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const transcript = participants.map((p) => `${p.name}: ${p.text}`).join("\n");
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Write a concise, factual meeting summary in 2-4 sentences, describing the topics participants discussed and any conclusions or next steps they mentioned. Use only the supplied participant speech. Do not infer or invent details. Return only the summary text.",
        },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq summary request failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error("Groq response had no meeting summary.");
  return summary.slice(0, 2000);
}

const SYSTEM_PROMPT = `You are analyzing a transcript of a multi-participant video meeting to help the meeting host understand how each participant performed. You will be given the transcript, labeled by speaker, and must score EVERY listed participant on exactly these 6 parameters, each an integer from 0 to 5 (0 = very poor, 5 = excellent):

- communication: How clearly and effectively they got their points across.
- fluency: Smoothness of speech — pacing, hesitation, filler words, false starts.
- topicKnowledge: How well their contributions reflected real understanding of what the group was discussing, not just relevance but depth and accuracy.
- teamworkListening: How well they engaged with OTHERS specifically — responding to what people said, building on it, acknowledging others' points — as distinct from just speaking on-topic themselves.
- leadershipInitiative: Whether they moved the conversation forward — proposing ideas, steering discussion, taking ownership of next steps — versus only reacting to others.
- confidenceProfessionalism: How assured, composed, and professional they sounded — tone and manner, as distinct from fluency's pacing/hesitation focus.

A transcript is an imperfect proxy for a real conversation: speech-to-text can drop words, miss context, or mis-transcribe names. Score based on what's actually there, and be moderate rather than extreme when the transcript is short or unclear — a brief but on-topic contribution shouldn't be scored as poorly as someone who said nothing relevant at all.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "scores": {
    "<userId>": {
      "communication": <int 0-5>,
      "fluency": <int 0-5>,
      "topicKnowledge": <int 0-5>,
      "teamworkListening": <int 0-5>,
      "leadershipInitiative": <int 0-5>,
      "confidenceProfessionalism": <int 0-5>,
      "summary": "<one short sentence of qualitative context>"
    }
  }
}
Include one entry per participant listed below, keyed by their exact numeric userId as a string.`;

function buildTranscriptPrompt(participants: ParticipantTranscript[]): string {
  const roster = participants.map((p) => `- ${p.name} (userId: ${p.userId})`).join("\n");
  const transcript = participants
    .map((p) => `### ${p.name} (userId: ${p.userId})\n${p.text}`)
    .join("\n\n");
  return `Participants in this meeting:\n${roster}\n\nTranscript, grouped by speaker (their turns may have been spoken interleaved with others' in the actual meeting — this grouping is just for readability):\n\n${transcript}`;
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 3; // neutral fallback (midpoint of 0-5) rather than silently dropping the participant
  return Math.max(0, Math.min(5, Math.round(n)));
}

/**
 * Scores every participant in one Groq call. Throws only on a total
 * failure to get ANY usable response (network error, non-JSON reply with
 * nothing salvageable) — a malformed or partial response is recovered
 * from per-field via clampScore rather than failing the whole batch, so
 * one bad field doesn't cost every participant their analysis.
 */
export async function analyzeMeeting(
  participants: ParticipantTranscript[],
): Promise<Map<number, ParticipantScores>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildTranscriptPrompt(participants) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq API request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  interface GroqChatResponse {
    choices?: { message?: { content?: string } }[];
  }
  const data = (await res.json()) as GroqChatResponse;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Groq response had no message content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Groq response was not valid JSON: ${String(err)}`);
  }

  const rawScores = (parsed as { scores?: Record<string, unknown> })?.scores;
  const result = new Map<number, ParticipantScores>();
  if (!rawScores || typeof rawScores !== "object") return result;

  for (const p of participants) {
    const entry = rawScores[String(p.userId)] as Record<string, unknown> | undefined;
    if (!entry) continue; // the model skipped this participant — nothing to record for them
    result.set(p.userId, {
      communication: clampScore(entry.communication),
      fluency: clampScore(entry.fluency),
      topicKnowledge: clampScore(entry.topicKnowledge),
      teamworkListening: clampScore(entry.teamworkListening),
      leadershipInitiative: clampScore(entry.leadershipInitiative),
      confidenceProfessionalism: clampScore(entry.confidenceProfessionalism),
      summary: typeof entry.summary === "string" ? entry.summary.slice(0, 500) : null,
    });
  }
  return result;
}
