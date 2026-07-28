import type { HealthAnalysis } from '../shared/types'
import { ANALYSIS_PEOPLE_JSON_FIELD, analysisPeoplePromptRule, coerceAnalysisPeople } from '../shared/people'
import { ANALYSIS_TIMELINE_JSON_FIELD, analysisTimelinePromptRule, coerceAnalysisTimeline } from '../shared/timeline'

export const HEALTH_ANALYSIS_SYSTEM_PROMPT = `You are a clinical-health synthesis assistant. Analyze the user's personal health documents and produce a structured health overview that a person could bring to a clinician. You are not providing medical advice — you are organizing and synthesizing self-reported information and prior research notes into a structured reference.

Synthesize, do not diagnose. Flag uncertainties and recommended follow-ups explicitly. Prefer concrete, actionable items over vague summaries.

Respond with ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "generatedAt": "<ISO 8601 timestamp>",
  "domainScores": [
    {
      "domain": "<cardiovascular|metabolic|endocrine|dermatologic|hair|cognitive|musculoskeletal|mental|sleep|nutrition|other>",
      "label": "<human-readable domain name>",
      "score": <0-100, subjective wellness/stability score>,
      "status": "<short phrase, e.g. 'Stable on protocol' or 'Monitor'>",
      "trend": "<up|down|stable|unknown>",
      "notes": "<1-3 sentence summary of current status>"
    }
  ],
  "regimen": {
    "medications": [
      { "name": "<name>", "dose": "<dose>", "schedule": "<schedule>", "category": "medication", "notes": "<optional>" }
    ],
    "supplements": [
      { "name": "<name>", "dose": "<dose>", "schedule": "<schedule>", "category": "supplement", "notes": "<optional>" }
    ],
    "notes": "<optional context about the regimen>"
  },
  "interactions": [
    {
      "description": "<what interacts and how>",
      "severity": "<low|medium|high>",
      "agents": ["<drug/supplement/condition name>", "..."]
    }
  ],
  "openThreads": [
    {
      "title": "<short title>",
      "detail": "<what needs attention and why>",
      "priority": "<low|medium|high>",
      "status": "<open|scheduled|done>",
      "dueDate": "<optional ISO date>"
    }
  ],
  "recommendedLabs": [
    { "name": "<lab name>", "rationale": "<why>", "status": "<pending|ordered|completed>" }
  ],
  "recentObservations": [
    { "name": "<metric/lab/symptom>", "value": "<value with unit>", "date": "<ISO date>", "flag": "<low|high|normal|abnormal>" }
  ],
${ANALYSIS_TIMELINE_JSON_FIELD}
${ANALYSIS_PEOPLE_JSON_FIELD}
  "summary": "<long-form narrative synthesis of the overall health picture: at least 3 substantial paragraphs when the records support it>"
}

Rules:
- Omit fields you cannot populate rather than inventing values. Empty arrays are acceptable.
- "domainScores" should cover every domain the documents substantively address.
- "interactions" includes drug-drug, drug-supplement, drug-condition, and lifestyle-factor interactions.
- "openThreads" are cross-cutting items worth tracking or raising with a provider.
- "recommendedLabs" are baseline labs worth requesting, not diagnostic directives.
${analysisTimelinePromptRule(40)}
${analysisPeoplePromptRule(10)}
- The health timeline is the clinical chronology: when each medication or protocol started or changed, when labs were drawn and how the values moved, when symptoms appeared or resolved, and when procedures or visits happened. Use the effective date carried by each observation — it is authoritative.
- Never include advice to start, stop, or change a medication or dose — defer to the prescriber.
- "summary" is the long-form part of this analysis. When the records carry enough signal, write AT LEAST three substantial paragraphs (roughly 450-750 words): the current picture across the domains the records cover; the concrete measured trends over time with their values, units, and dates, including how findings in one domain relate to another; and what is unresolved — open questions, gaps in the record, and what a clinician would most want to look at next. Extra length must buy more clinical specificity and more evidence — never repetition, never a restatement of the structured fields above, never filler. If the records are thin, a shorter honest summary is correct: do not pad.
- "generatedAt" must be the current time in ISO 8601.`

export function emptyHealthAnalysis(reason: string): HealthAnalysis {
  return {
    generatedAt: new Date().toISOString(),
    domainScores: [],
    regimen: { medications: [], supplements: [], notes: reason },
    interactions: [],
    openThreads: [],
    recommendedLabs: [],
    recentObservations: [],
    timeline: [],
    summary: reason,
  }
}

function extractJsonObject(text: string): string {
  let trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim()
  }
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

export function parseHealthAnalysisResponse(text: string): HealthAnalysis {
  const jsonText = extractJsonObject(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    const snippet = text.length > 300 ? text.slice(0, 300) + '...' : text
    throw new Error(
      `Health analysis response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Response starts with: ${JSON.stringify(snippet)}`
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Health analysis response is not an object')
  }
  const obj = parsed as Partial<HealthAnalysis>
  if (!Array.isArray(obj.domainScores)) {
    throw new Error('Health analysis response missing domainScores array')
  }
  if (!obj.regimen || !Array.isArray(obj.regimen.medications) || !Array.isArray(obj.regimen.supplements)) {
    throw new Error('Health analysis response missing regimen.medications/supplements')
  }
  if (!Array.isArray(obj.interactions) || !Array.isArray(obj.openThreads) || !Array.isArray(obj.recommendedLabs)) {
    throw new Error('Health analysis response missing interactions/openThreads/recommendedLabs')
  }
  if (typeof obj.summary !== 'string') {
    throw new Error('Health analysis response missing summary string')
  }
  if (!Array.isArray(obj.recentObservations)) {
    obj.recentObservations = []
  }
  if (!obj.generatedAt || typeof obj.generatedAt !== 'string') {
    obj.generatedAt = new Date().toISOString()
  }
  obj.timeline = coerceAnalysisTimeline((parsed as Record<string, unknown>).timeline)
  obj.people = coerceAnalysisPeople((parsed as Record<string, unknown>).people)
  return obj as HealthAnalysis
}
