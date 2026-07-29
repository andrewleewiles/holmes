// An icon for every role tool in the Work sidebar, so the role nav reads like
// the Life and Leisure navs rather than like a bare list.
//
// Keyed by `${roleId}:${tool}` rather than by tool name alone, because the same
// word means different things to different roles: "Model" is a mesh to Geppetto
// and a statistical model to Gradgrind, and they should not share an icon.
//
// The tools themselves come from assets/characterRoles.xlsx via
// src/shared/workRoles.ts. A tool added to the sheet without an entry here still
// renders — it falls back to a neutral marker — so the sheet stays editable
// without a code change being mandatory.
import {
  faBone, faBookOpen, faBroom, faBug, faCamera, faChartColumn, faCircleCheck, faCirclePlus,
  faClipboardList, faClone, faCommentDots, faComments, faCube, faCubes, faDrawPolygon,
  faFileExport, faFileImport, faFileLines, faFillDrip, faFlask, faGamepad, faGears,
  faHammer, faHandSparkles, faImages, faLightbulb, faListCheck, faMagnifyingGlassChart,
  faMap, faPenNib, faScaleBalanced, faShapes, faShareFromSquare, faSquareRootVariable,
  faSwatchbook, faTerminal, faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons'

type Icon = typeof faCirclePlus

const TOOL_ICONS: Record<string, Icon> = {
  // 3D Modeler — Geppetto
  '3d-modeler:References': faImages,
  '3d-modeler:Blockout': faCubes,
  '3d-modeler:Model': faCube,
  '3d-modeler:Sculpt': faHandSparkles,
  '3d-modeler:Retopology': faDrawPolygon,
  '3d-modeler:Materials': faFillDrip,
  '3d-modeler:Rig': faBone,
  '3d-modeler:Render': faCamera,
  '3d-modeler:Validate': faCircleCheck,
  '3d-modeler:Export': faFileExport,

  // Designer — Basil
  'designer:Brief': faClipboardList,
  'designer:Moodboard': faSwatchbook,
  'designer:Concepts': faLightbulb,
  'designer:Create': faPenNib,
  'designer:Variations': faClone,
  'designer:Critique': faCommentDots,
  'designer:Design System': faShapes,
  'designer:Polish': faWandMagicSparkles,
  'designer:Handoff': faShareFromSquare,

  // Data Analyst — Gradgrind
  'data-analyst:Import': faFileImport,
  'data-analyst:Clean': faBroom,
  'data-analyst:Explore': faMagnifyingGlassChart,
  'data-analyst:Query': faTerminal,
  'data-analyst:Visualize': faChartColumn,
  'data-analyst:Model': faSquareRootVariable,
  'data-analyst:Explain': faComments,
  'data-analyst:Report': faFileLines,

  // Game Studio — Oz
  'game-studio:Design Doc': faFileLines,
  'game-studio:Prototype': faFlask,
  'game-studio:Systems': faGears,
  'game-studio:Levels': faMap,
  'game-studio:Narrative': faBookOpen,
  'game-studio:Balance': faScaleBalanced,
  'game-studio:Debug': faBug,
  'game-studio:Playtest': faGamepad,
  'game-studio:Build': faHammer,
}

/**
 * Every role's list opens with its own "New …" — the job New Conversation does
 * in the other navs — so it gets the same icon New Conversation uses.
 */
export function workToolIcon(roleId: string, tool: string): Icon {
  if (tool.startsWith('New ')) return faCirclePlus
  return TOOL_ICONS[`${roleId}:${tool}`] ?? faListCheck
}

/** Exported for the test that asserts the sheet and this map have not drifted. */
export const WORK_TOOL_ICON_KEYS = Object.keys(TOOL_ICONS)
