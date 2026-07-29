// GENERATED FILE — do not edit by hand.
//
// Source: assets/characterRoles.xlsx
// Regenerate: node scripts/generate-work-roles.mjs
//
// The workbook is where these are authored; this module exists so the app does
// not have to parse a spreadsheet at boot. Editing here is lost on the next run.

/** One row of the character/role sheet, as the Work tab uses it. */
export interface WorkRole {
  /** Slug of the role name, stable across renames of the character. */
  id: string
  /** The Role column — what the dropdown lists. */
  role: string
  /** The Name column — the character who embodies the role. */
  character: string
  color: string
  /**
   * The Tools column, one entry per line in the sheet. Empty when no tools have
   * been authored for the role yet, in which case the Work tab keeps its
   * default actions rather than showing an empty nav.
   */
  tools: string[]
}

export const WORK_ROLES: readonly WorkRole[] = [
  {
    id: "general",
    role: "General",
    character: "Holmes",
    color: "#47a08f",
    tools: [],
  },
  {
    id: "therapist",
    role: "Therapist",
    character: "Seward",
    color: "#8861b5",
    tools: [],
  },
  {
    id: "3d-modeler",
    role: "3D Modeler",
    character: "Geppetto",
    color: "#bc9357",
    tools: ["New Model", "References", "Blockout", "Model", "Sculpt", "Retopology", "Materials", "Rig", "Render", "Validate", "Export"],
  },
  {
    id: "designer",
    role: "Designer",
    character: "Basil",
    color: "#6856e8",
    tools: ["New Design", "Brief", "Moodboard", "Concepts", "Create", "Variations", "Critique", "Design System", "Polish", "Handoff"],
  },
  {
    id: "data-analyst",
    role: "Data Analyst",
    character: "Gradgrind",
    color: "#5c6b5e",
    tools: ["New Analysis", "Import", "Clean", "Explore", "Query", "Visualize", "Model", "Explain", "Report"],
  },
  {
    id: "programmer",
    role: "Programmer",
    character: "Cavor",
    color: "#6ca7b7",
    tools: [],
  },
  {
    id: "game-studio",
    role: "Game Studio",
    character: "Oz",
    color: "#63a800",
    tools: ["New Project", "Design Doc", "Prototype", "Systems", "Levels", "Narrative", "Balance", "Debug", "Playtest", "Build"],
  },
  {
    id: "writer",
    role: "Writer",
    character: "Cyrano",
    color: "#a36774",
    tools: [],
  },
]

const BY_ID: ReadonlyMap<string, WorkRole> = new Map(WORK_ROLES.map((role) => [role.id, role]))

export function getWorkRole(id: string | null | undefined): WorkRole | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}

export function isWorkRoleId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value)
}

/** Roles that actually change the action list. */
export function workRolesWithTools(): WorkRole[] {
  return WORK_ROLES.filter((role) => role.tools.length > 0)
}
