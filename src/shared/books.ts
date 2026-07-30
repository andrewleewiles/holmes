// The e-book Library contract, shared by main, preload and the renderer.
//
// The governing rule of this feature lives here as a shape rather than a
// comment: nothing in these types carries book prose except `BookChapterContent`
// and the annotation `quote`, and neither is ever persisted. Chapter text is
// derived on demand from the file on disk. What IS persisted is the shelf and
// the reading record — which is all that reaches the life picture.

export type BookFormat = 'epub' | 'pdf'

export type BookScanStatus = 'pending' | 'ready' | 'failed'

export type BookReadingStatus = 'unread' | 'reading' | 'finished' | 'abandoned' | 'reference'

export const BOOK_READING_STATUSES: readonly BookReadingStatus[] = [
  'unread', 'reading', 'finished', 'abandoned', 'reference',
] as const

export interface Book {
  id: string
  projectId: string
  /** The connected directory this book was found under. */
  sourcePath: string
  filePath: string
  relativePath: string
  format: BookFormat
  /** sha256(realpath + size + mtime + scan version) — the cheap rescan gate. */
  identityHash: string
  /** Hash of the canonical text. Annotation offsets are only valid against this. */
  textHash: string
  fileSize: number
  title: string
  subtitle: string | null
  authors: string[]
  publisher: string | null
  publishedDate: string | null
  language: string | null
  identifier: string | null
  subjects: string[]
  description: string | null
  /** A downscaled JPEG data: URL, or null when there is no usable cover. */
  coverDataUrl: string | null
  chapterCount: number
  wordCount: number
  status: BookScanStatus
  scanError: string | null
  /** Set when the file went missing. The row is kept — see the scanner's prune rule. */
  missingSince: string | null
  addedAt: number
  updatedAt: number
}

export interface BookChapter {
  id: string
  bookId: string
  spineIndex: number
  href: string
  anchor: string | null
  title: string
  navDepth: number
  /** Absolute offsets into the book's canonical text — the one coordinate space. */
  charStart: number
  charEnd: number
  wordCount: number
  pageStart: number | null
  pageEnd: number | null
}

export interface BookReadingState {
  bookId: string
  status: BookReadingStatus
  lastChapterIndex: number
  lastCharOffset: number
  /** Monotonic: the deepest point ever reached, so re-reading cannot lower progress. */
  furthestCharOffset: number
  progressPercent: number
  rating: number | null
  startedAt: string | null
  finishedAt: string | null
  secondsRead: number
  notes: string
  updatedAt: number
}

export interface BookReadingSession {
  id: string
  bookId: string
  startedAt: string
  endedAt: string
  chapterStart: number
  chapterEnd: number
  charsAdvanced: number
  seconds: number
}

/** A shelf entry: the book plus its reading record and cheap counts. */
export interface LibraryBook {
  book: Book
  reading: BookReadingState
  lessonCount: number
  annotationCount: number
}

// --- chapter content -------------------------------------------------------
// A typed block AST crosses the IPC bridge, never HTML. The app contains no
// dangerouslySetInnerHTML, and the CSP permits inline styles — so a <style>
// block inside a downloaded book could restyle the whole application. An AST
// makes that impossible by construction rather than by sanitizer correctness.

export type BookLink =
  | { kind: 'internal'; chapterIndex: number; anchor?: string }
  | { kind: 'external'; url: string }

export type BookMark = 'em' | 'strong' | 'code' | 'sup' | 'sub' | 'small'

export interface BookInline {
  text: string
  marks?: BookMark[]
  link?: BookLink
  /** Absolute offset of this run's first character in the canonical text. */
  start: number
}

export type BookBlockKind =
  | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'li' | 'blockquote' | 'pre' | 'figcaption' | 'hr' | 'img' | 'pagebreak'

export interface BookBlock {
  kind: BookBlockKind
  start: number
  end: number
  inlines: BookInline[]
  anchorId?: string
  listOrdered?: boolean
  listDepth?: number
  /** Images are fetched separately: inlining them would make a chapter a multi-MB IPC message. */
  resourceId?: string
  alt?: string
  page?: number
}

export interface BookChapterContent {
  bookId: string
  chapterIndex: number
  title: string
  charStart: number
  charEnd: number
  blocks: BookBlock[]
  truncated: boolean
}

export interface BookResource {
  /** A data: URL — already permitted by the CSP's `img-src 'self' data:`. */
  dataUrl: string
  width: number
  height: number
}

// --- scanning --------------------------------------------------------------

export interface LibraryScanProgress {
  phase: 'scanning' | 'parsing' | 'filing' | 'complete'
  message: string
  current: number
  total: number | null
  bookTitle?: string
}

export interface LibraryRunState {
  status: 'idle' | 'scanning' | 'generating'
  origin: 'user' | 'timer' | null
  progress: LibraryScanProgress | null
  message: string | null
  updatedAt: string
}

export interface LibraryScanResult {
  booksFound: number
  booksAdded: number
  booksUpdated: number
  booksUnchanged: number
  booksFailed: number
  booksMissing: number
  /** Files found at a new path and recognised as a book already on the shelf,
   *  which keeps its id and everything attached to it. */
  booksMoved: number
  /** Entries that had already been split in two by a move, folded back together. */
  booksMerged: number
  /** Pruning only runs on a complete scan — see the scanner. */
  pruned: number
  scanComplete: boolean
  unreadableRoots: string[]
  /** Books auto-filed into `Author - Title` folders after this scan. Absent
   *  when auto-filing is off, offline, or had nothing new to consider. */
  booksFiled?: number
  /** Books the auto-filing pass looked at and left in place — ambiguous names,
   *  already filed, or a folder collision. They will not be asked about again. */
  filingSkipped?: number
}

/** What a reading-record refresh did. `generated: false` is a cache hit, not a failure. */
export interface LibrarySnapshotResult {
  generated: boolean
  bookCount: number
  contextShort: string | null
  context: string | null
}

// --- lessons ---------------------------------------------------------------

export interface BookCitation {
  chapterIndex: number
  charStart: number
  charEnd: number
  quote: string
}

export interface BookLessonConcept {
  id: string
  term: string
  explanation: string
  citations: BookCitation[]
}

export type BookQuestionKind = 'multiple_choice' | 'open'

export interface BookLessonQuestion {
  id: string
  kind: BookQuestionKind
  prompt: string
  /** Empty for open questions. */
  choices: string[]
  correctIndex: number | null
  modelAnswer: string
  explanation: string
  citations: BookCitation[]
}

export type BookLessonStepKind = 'objectives' | 'concept' | 'question' | 'summary'

export interface BookLessonStep {
  id: string
  kind: BookLessonStepKind
  title: string
  body: string
  /** Set when `kind === 'concept'` / `'question'`. */
  conceptId?: string
  questionId?: string
}

export interface BookLesson {
  id: string
  bookId: string
  chapterStart: number
  chapterEnd: number
  title: string
  overview: string
  objectives: string[]
  concepts: BookLessonConcept[]
  questions: BookLessonQuestion[]
  steps: BookLessonStep[]
  promptVersion: string
  model: string
  status: BookScanStatus
  error: string | null
  costUsd: number | null
  inputTokens: number
  outputTokens: number
  generatedAt: string
}

export interface BookLessonAttempt {
  id: string
  lessonId: string
  questionId: string
  answer: string
  choiceIndex: number | null
  correct: boolean | null
  selfRating: number | null
  revealed: boolean
  createdAt: number
}

// --- annotations -----------------------------------------------------------

export type AnnotationAnchorStatus = 'exact' | 'shifted' | 'orphaned'

export interface BookAnnotation {
  id: string
  runId: string | null
  bookId: string
  chapterIndex: number
  charStart: number
  charEnd: number
  quote: string
  /** 32 chars either side — the W3C TextQuoteSelector pattern, for re-anchoring. */
  prefix: string
  suffix: string
  kind: string
  label: string
  body: string
  origin: 'ai' | 'manual'
  pinned: boolean
  anchorStatus: AnnotationAnchorStatus
  createdAt: number
  updatedAt: number
}

export interface BookAnnotationRun {
  id: string
  bookId: string
  focusKey: string
  focusLabel: string
  customFocus: string | null
  promptVersion: string
  chapterStart: number
  chapterEnd: number
  textHash: string
  model: string
  status: BookScanStatus
  error: string | null
  annotationCount: number
  /** Annotations whose quote could not be located. Surfaced, never silently dropped. */
  droppedCount: number
  costUsd: number | null
  inputTokens: number
  outputTokens: number
  createdAt: string
  updatedAt: string
}

/** What one annotation run produced. `dropped` is surfaced, never hidden. */
export interface AnnotationRunSummary {
  runId: string
  created: number
  /** Annotations whose quote could not be located in the text. */
  dropped: number
  cached: boolean
}

/** What one lesson run produced. `droppedCitations` is surfaced, never hidden. */
export interface LessonRunSummary {
  lesson: BookLesson
  cached: boolean
  /** Citations whose quote could not be found in the text, and so were removed. */
  droppedCitations: number
}

// --- audiobook ---------------------------------------------------------------
// Narration generated by ElevenLabs, with per-character timing mapped back into
// the book's canonical text so the reader can follow along word by word.

export type AudiobookStatus = 'pending' | 'generating' | 'ready' | 'failed'

/**
 * Word timings for one segment.
 *
 * Parallel arrays rather than an array of objects: a chapter carries several
 * thousand words, and this crosses the IPC bridge on every chapter open.
 * `charStart`/`charEnd` are absolute offsets into the book's canonical text —
 * the SAME coordinate space as chapters, annotations and lesson citations — so
 * the highlighter reuses the span machinery that already exists.
 * `startSeconds`/`endSeconds` are relative to this segment's own audio.
 */
export interface AudiobookWordTimings {
  charStart: number[]
  charEnd: number[]
  startSeconds: number[]
  endSeconds: number[]
}

export interface AudiobookSegment {
  id: string
  segmentIndex: number
  /** Providers may return different containers; the player needs the type. */
  mimeType: string
  charStart: number
  charEnd: number
  durationSeconds: number
  /** Seconds of chapter audio before this segment starts. */
  offsetSeconds: number
  /** holmes-audio:// URL — an opaque id, never a path. */
  url: string
  words: AudiobookWordTimings
}

export interface Audiobook {
  id: string
  bookId: string
  chapterIndex: number
  /** Which service narrated this. Two chapters of one book may differ. */
  provider: SpeechProviderId
  voiceId: string
  voiceName: string
  modelId: string
  /** The canonical-text hash these timings were measured against. */
  textHash: string
  charStart: number
  charEnd: number
  characterCount: number
  durationSeconds: number
  status: AudiobookStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

/** A chapter's narration plus everything needed to play and follow it. */
export interface AudiobookChapter {
  audiobook: Audiobook
  segments: AudiobookSegment[]
  /** True when the book's text changed after this was generated. */
  stale: boolean
}

/** Which speech service narrated, or is being asked to. */
export type SpeechProviderId = 'elevenlabs' | 'speechify'

export interface SpeechProviderInfo {
  id: SpeechProviderId
  label: string
  /** Where to get a key, shown when none is set. */
  keyUrl: string
  /** How the key looks, so a pasted wrong one is obvious. */
  keyHint: string
  configured: boolean
  quota: SpeechQuota | null
}

export interface ElevenLabsVoice {
  voiceId: string
  name: string
  category: string
  description: string | null
  labels: Record<string, string>
  previewUrl: string | null
}

export type SpeechVoice = ElevenLabsVoice

export interface ElevenLabsModel {
  modelId: string
  name: string
  description: string
  /** Per-request character cap. Chapters are split to fit it. */
  maxCharacters: number
  /** Relative credit cost per character, 1 = standard. */
  costMultiplier: number
  canStitch: boolean
}

export type SpeechModel = ElevenLabsModel

export interface ElevenLabsQuota {
  tier: string
  characterCount: number
  characterLimit: number
  /** ISO date the allowance resets, when the plan reports one. */
  nextResetAt: string | null
}

export type SpeechQuota = ElevenLabsQuota

/** Whether narration is available at all, and what allowance is left. */
export interface ElevenLabsStatus {
  configured: boolean
  quota: ElevenLabsQuota | null
}

export interface ElevenLabsKeyResult {
  ok: boolean
  message: string
  quota: ElevenLabsQuota | null
}

export type SpeechKeyResult = ElevenLabsKeyResult

export interface AudiobookEstimate {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  characterCount: number
  segmentCount: number
  provider: SpeechProviderId
  modelId: string
  /** Null when the key has no readable quota (a key without user scope). */
  quota: ElevenLabsQuota | null
  /** True when this chapter alone would exceed what is left. */
  exceedsQuota: boolean
  estimatedSeconds: number
  /** Set when narration already exists and matches the current text. */
  alreadyGenerated: boolean
}

export interface AudiobookProgress {
  phase: 'synthesizing' | 'writing' | 'complete'
  message: string
  current: number
  total: number
  chapterIndex: number
}

// --- file organisation -------------------------------------------------------

export interface OrganizePlanEntry {
  bookId: string
  title: string
  authors: string[]
  currentPath: string
  /** Null when this book will not move. */
  targetPath: string | null
  folderName: string
  /** Files that travel with the book: cover, .opf, annotations. */
  sidecars: string[]
  /** Set when it will be left alone, saying why. */
  skipped: string | null
}

export interface OrganizePlan {
  projectId: string
  entries: OrganizePlanEntry[]
  moveCount: number
  skipCount: number
}

export interface OrganizeResult {
  moved: number
  skipped: number
  failed: Array<{ bookId: string; title: string; error: string }>
}

// --- guest redaction ---------------------------------------------------------
// A `media`-scoped device is a stranger the owner shared the shelf with. The
// Library types were designed for one reader — the owner — so they carry the
// owner's reading record and the Mac's filesystem layout alongside the
// bibliographic data a shelf actually needs. These helpers are the narrowing,
// and they live here rather than in the handler so they are pure and testable.
//
// The rule: a guest sees what is printed on the book, plus enough structure to
// read it. Nothing about the owner and nothing about the disk.

/** Blanked rather than deleted, so the shape stays assignable to `Book`. */
export const GUEST_BLANKED_BOOK_FIELDS = [
  'sourcePath', 'filePath', 'relativePath', 'identityHash', 'textHash',
] as const

/**
 * A guest-safe `Book`: title, subtitle, authors, publisher, dates, language,
 * format, cover, counts and scan status survive; every path and every identity
 * or text hash is blanked.
 *
 * The hashes go for two separate reasons. `identityHash` is
 * sha256(realpath + size + mtime), which is an offline oracle for the file's
 * location on the Mac. `textHash` is the hash of the exact canonical text, which
 * confirms possession of a specific copy. Neither is needed to read a book.
 */
export function redactBookForGuest(book: Book): Book {
  return {
    ...book,
    sourcePath: '',
    filePath: '',
    relativePath: '',
    identityHash: '',
    textHash: '',
  }
}

/**
 * The reading record is the OWNER's — there is one row per book and per-guest
 * reading state does not exist. So a guest is handed a neutral, unstarted
 * record rather than the owner's rating, private notes, progress and dates.
 *
 * This is deliberately not "hide the notes and keep the progress": "73% read,
 * finished 3 March" is a statement about the owner's month, and the reading
 * record feeds the life timeline. A guest's reader opens at the beginning,
 * which is the correct behaviour for a copy they have never read.
 */
export function guestReadingState(bookId: string): BookReadingState {
  return {
    bookId,
    status: 'unread',
    lastChapterIndex: 0,
    lastCharOffset: 0,
    furthestCharOffset: 0,
    progressPercent: 0,
    rating: null,
    startedAt: null,
    finishedAt: null,
    secondsRead: 0,
    notes: '',
    updatedAt: 0,
  }
}

/**
 * A shelf entry for a guest. The lesson and annotation counts are zeroed too:
 * they count artifacts the owner paid a model to produce, the channels that
 * would fetch them are denied to a guest, and the number alone still reports
 * how much attention the owner gave that book.
 */
/**
 * `reading` is the GUEST's own position when they have one, never the owner's.
 * Omitting it yields a neutral unstarted record, which is what a guest who has
 * not opened the book should see.
 */
export function redactLibraryBookForGuest(entry: LibraryBook, reading?: BookReadingState | null): LibraryBook {
  return {
    book: redactBookForGuest(entry.book),
    reading: reading ?? guestReadingState(entry.book.id),
    lessonCount: 0,
    annotationCount: 0,
  }
}

/** A guest-safe narration record: no text hash, and no provider error text. */
export function redactAudiobookForGuest(audiobook: Audiobook): Audiobook {
  return {
    ...audiobook,
    textHash: '',
    // Provider errors quote the owner's plan and quota back at them.
    error: audiobook.error ? 'Narration is unavailable for this chapter' : null,
  }
}

export function redactAudiobookChapterForGuest(chapter: AudiobookChapter): AudiobookChapter {
  return {
    ...chapter,
    audiobook: redactAudiobookForGuest(chapter.audiobook),
  }
}

// --- discussion handoff ----------------------------------------------------

export interface BookDiscussionScope {
  title: string
  systemPrompt: string
  seedPrompt: string
}

export interface BookConversationLink {
  id: string
  bookId: string
  conversationId: string
  chapterIndex: number | null
  lessonId: string | null
  stepId: string | null
  createdAt: number
}
