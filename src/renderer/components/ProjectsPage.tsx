import { type FC, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFolderTree, faPlus } from '@fortawesome/free-solid-svg-icons'
import type { Project } from '@shared/types'
import { ProjectIcon } from './ProjectIcon'
import { IconPicker } from './IconPicker'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

interface ProjectsPageProps {
  projects: Project[]
  onCreate: (data: { name: string; icon: string; color: string }) => Promise<Project | void>
  onUpdate: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSelectDirectory: () => Promise<string | null>
  onAddFile: (projectId: string, filePath: string) => Promise<void>
  onRemoveFile: (projectId: string, filePath: string) => Promise<void>
  onSelectFiles: () => Promise<string[]>
  onSelectImage: () => Promise<string | null>
}

const COLOR_OPTIONS = ['#47a08f', '#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4']

export const ProjectsPage: FC<ProjectsPageProps> = ({
  projects,
  onCreate,
  onUpdate,
  onDelete,
  onSelectDirectory,
  onAddFile,
  onRemoveFile,
  onSelectFiles,
  onSelectImage,
}) => {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('folder')
  const [newColor, setNewColor] = useState(COLOR_OPTIONS[0])
  const [editingIconId, setEditingIconId] = useState<string | null>(null)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    await onCreate({ name, icon: newIcon, color: newColor })
    setNewName('')
    setNewIcon('folder')
    setNewColor(COLOR_OPTIONS[0])
    setCreating(false)
  }

  const handleBrowse = async (project: Project) => {
    const dir = await onSelectDirectory()
    if (dir) {
      await onUpdate(project.id, { path: dir })
    }
  }

  const handleClearPath = async (id: string) => {
    await onUpdate(id, { path: null })
  }

  const handleAddFiles = async (projectId: string) => {
    const files = await onSelectFiles()
    for (const file of files) {
      await onAddFile(projectId, file)
    }
  }

  function fileName(path: string): string {
    return path.split('/').pop() || path.split('\\').pop() || path
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faFolderTree} className={PAGE_HEADER_ICON} />}
        title="Projects"
        actions={
          <button
            onClick={() => setCreating((value) => !value)}
            className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
          >
            <FontAwesomeIcon icon={faPlus} className="text-[13px]" />
            New project
          </button>
        }
      />

      <div className="max-w-5xl w-full mx-auto px-8 py-6">

        {creating && (
          <div className="mb-6 bg-holmes-surface rounded-2xl border border-white/10 p-5">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="Project name"
              className="w-full mb-4 rounded-md border border-white/15 bg-transparent px-3 py-2 text-sm text-white outline-none focus:border-holmes-primary"
            />
            <div className="mb-4">
              <span className="block text-xs text-white/40 mb-1.5">Icon</span>
              <IconPicker value={newIcon} onChange={setNewIcon} onSelectImage={onSelectImage} />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <span className="text-xs text-white/40 w-16">Color</span>
              <div className="flex gap-2">
                {COLOR_OPTIONS.map((color) => (
                  <button
                    key={color}
                    onClick={() => setNewColor(color)}
                    className={`h-6 w-6 rounded-full border-2 transition-transform ${
                      newColor === color ? 'border-white scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="text-xs px-3 py-1.5 rounded-md bg-holmes-primary text-white hover:bg-holmes-primary-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
              <button
                onClick={() => setCreating(false)}
                className="text-xs px-3 py-1.5 rounded-md text-white/50 hover:text-white/80 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="bg-holmes-surface rounded-2xl border border-white/10 p-10 text-center">
            <p className="text-sm text-white/40">No projects yet. Create one to organize files for a specific effort.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group relative bg-holmes-surface rounded-2xl border border-white/10 p-5 hover:border-white/20 transition-colors"
              >
                <div className="flex items-start justify-between mb-4">
                  <button
                    onClick={() => setEditingIconId((current) => (current === project.id ? null : project.id))}
                    className="flex items-center justify-center rounded-md transition-opacity cursor-pointer hover:opacity-80"
                    title="Change icon"
                  >
                    <ProjectIcon icon={project.icon} className="text-3xl" />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                        void onDelete(project.id)
                      }
                    }}
                    className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                    title="Delete project"
                  >
                    ×
                  </button>
                </div>

                {editingIconId === project.id && (
                  <div className="mb-4 rounded-md border border-white/10 bg-black/20 p-3">
                    <IconPicker
                      value={project.icon}
                      onChange={(icon) => onUpdate(project.id, { icon })}
                      onSelectImage={onSelectImage}
                    />
                    <button
                      onClick={() => setEditingIconId(null)}
                      className="mt-2 text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                )}

                <h2 className="text-base font-medium text-white/80 mb-3 font-serif-display">{project.name}</h2>

                {project.path ? (
                  <div className="flex items-center gap-1.5 mb-3">
                    <svg className="w-3.5 h-3.5 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="text-xs text-white/40 truncate flex-1">{project.path}</span>
                    <button
                      onClick={() => handleClearPath(project.id)}
                      className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer shrink-0"
                      title="Remove directory"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleBrowse(project)}
                    className="mb-3 text-xs text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    Set directory...
                  </button>
                )}

                <div className="space-y-1 mb-3 max-h-32 overflow-y-auto scrollbar-thin">
                  {project.files.map((f) => (
                    <div key={f} className="flex items-center gap-1.5 group/file">
                      <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="text-[11px] text-white/50 truncate flex-1" title={f}>{fileName(f)}</span>
                      <button
                        onClick={() => onRemoveFile(project.id, f)}
                        className="opacity-0 group-hover/file:opacity-100 text-[10px] text-white/30 hover:text-red-400 transition-all cursor-pointer shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => handleAddFiles(project.id)}
                  className="text-xs text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add files
                </button>

                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: project.color }}
                  />
                  <span className="text-[10px] text-white/30 uppercase tracking-wider">{project.name}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
